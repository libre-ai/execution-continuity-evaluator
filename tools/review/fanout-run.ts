import { createHash, getRandomValues, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvelopeKey } from "@libre-ai/envelope";
import {
  buildJobs,
  buildPrompt,
  dedupeJobs,
  extractVerdict,
  guardEvidence,
  parseJournalLines,
  type ReviewEvent,
  type ReviewEventType,
  type ReviewJob,
  type ReviewPlan,
  reconcileReplay,
  replayPassStatuses,
  runBatched,
  validateVerdict,
} from "./fanout-core";
import {
  assertReadable,
  type ClosedManifest,
  type CoverageRequest,
  closeManifest,
  type DiffEntry,
  describePatch,
  formatClosure,
  isSecretPath,
  loadRulesAtBase,
  parseNameStatusZ,
  type ReviewRules,
  type SealedManifest,
  sealManifest,
  selectFiles,
  settleFromCampaign,
} from "./fanout-coverage";

// Effects of the review fan-out (git, `pi`, filesystem, journal) and the
// default driver that sequences them. `fanout.ts` is the command line;
// `fanout-graph.ts` is the second driver, over the same pieces. Both produce
// a `CampaignOutcome`, which is what makes their equivalence testable.

export type Emit = (
  type: ReviewEventType,
  detail?: Record<string, unknown>,
  span?: { readonly startedAt: string },
) => Promise<void>;

export interface JobResult {
  job: ReviewJob;
  ok: boolean;
  errors: string[];
  durationMs: number;
}

/** Where a campaign reports; injected so drivers can be compared line for line. */
export interface CampaignIo {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

export const consoleIo: CampaignIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function git(args: string[], cwd = "."): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

/**
 * Append-only JSONL journal, written while passes run rather than at the end.
 *
 * One line per event, appended in `a` mode: concurrent passes each write a
 * single short line, which POSIX append keeps atomic at this size. Nothing here
 * buffers — a hung or killed pass is exactly when the journal earns its keep,
 * and it would flush nothing at exit.
 */
export function journalWriter(path: string, job: ReviewJob): Emit {
  return async (type, detail, span) => {
    const now = new Date().toISOString();
    const event: ReviewEvent = {
      reviewPassId: job.reviewPassId,
      role: job.role,
      type,
      at: span?.startedAt ?? now,
      ...(span === undefined ? {} : { endedAt: now }),
      ...(detail === undefined ? {} : { detail }),
    };
    await appendFile(path, `${JSON.stringify(event)}\n`);
  };
}

/**
 * The shared evidence digest: each declared evidence file, then the sealed
 * review scope when coverage was requested. Both are wrapped as untrusted:
 * file contents and changed paths are written by whoever authored the commit.
 * A secret path is refused here too, not only at selection.
 */
export async function buildEvidenceDigest(
  plan: ReviewPlan,
  key: EnvelopeKey,
  repoDir: string,
  reviewScope: string | null = null,
): Promise<string> {
  const scopeSection =
    reviewScope === null
      ? []
      : [
          `### review scope (sealed coverage manifest)\n\n${guardEvidence(
            "review-scope",
            reviewScope,
            key,
            new Date().toISOString(),
          )}`,
        ];
  if (plan.evidence.length === 0) {
    return scopeSection.length === 0
      ? "(no shared evidence files declared)"
      : ["(no shared evidence files declared)", ...scopeSection].join("\n\n");
  }
  const sections: string[] = [];
  for (const path of plan.evidence) {
    assertReadable(path);
    const content = await git(["show", `${plan.commit}:${path}`], repoDir);
    const sha256 = createHash("sha256").update(content).digest("hex");
    // K3 enforcement: wrap evidence in integrity envelope before the prompt.
    // guardEvidence verifies undetectability of alteration, escapes delimiter code points.
    const guarded = guardEvidence(path, content, key, new Date().toISOString());
    sections.push(`### ${path} (sha256 ${sha256})\n\n${guarded}`);
  }
  return [...sections, ...scopeSection].join("\n\n");
}

async function runJob(
  plan: ReviewPlan,
  job: ReviewJob,
  worktreeBase: string,
  evidenceDigest: string,
  emit: Emit,
  repoDir: string,
  piBinary: string,
): Promise<JobResult> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const worktree = join(worktreeBase, job.role);
  const errors: string[] = [];
  await emit("pass_start", { commit: job.commit, mode: job.mode });
  try {
    await git(["worktree", "add", "--detach", worktree, job.commit], repoDir);
    await emit("worktree_ready");
    try {
      const prompt = buildPrompt(job, evidenceDigest);
      const agentStartedAt = new Date().toISOString();
      const proc = Bun.spawn(
        [
          piBinary,
          "--print",
          "--provider",
          plan.provider,
          "--model",
          plan.model,
          "--thinking",
          plan.thinking,
          prompt,
        ],
        { cwd: worktree, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      // The agent call is the only step that spans time, so it is the only
      // event carrying both endpoints.
      await emit(
        "agent_call",
        { exitCode, provider: plan.provider, model: plan.model, thinking: plan.thinking },
        { startedAt: agentStartedAt },
      );
      if (exitCode !== 0) {
        errors.push(`pi exited ${exitCode}: ${stderr.trim().slice(0, 500)}`);
      } else {
        const dirty = (await git(["status", "--porcelain"], worktree)).trim();
        if (dirty.length > 0) {
          errors.push(`worktree dirty after review pass, pass invalid:\n${dirty}`);
          // A reviewer that wrote to the tree it was reviewing is a breach, not
          // a finding: the write already happened and no rerun undoes it.
          await emit("worktree_dirty", { paths: dirty.split("\n").length });
        } else {
          const verdict = extractVerdict(stdout);
          errors.push(...validateVerdict(verdict, job));
          if (errors.length > 0) await emit("verdict_rejected", { violations: errors.length });
          if (errors.length === 0) {
            const record = {
              ...(verdict as Record<string, unknown>),
              runner: {
                orchestrator: "tools/review/fanout.ts",
                provider: plan.provider,
                model: plan.model,
                thinking: plan.thinking,
                startedAt,
                durationMs: Math.round(performance.now() - start),
              },
            };
            await Bun.write(job.outputPath, `${JSON.stringify(record, null, 2)}\n`);
            await emit("verdict_recorded", { outputPath: job.outputPath });
          }
        }
      }
    } finally {
      await git(["worktree", "remove", "--force", worktree], repoDir);
      await emit("worktree_removed");
    }
  } catch (cause) {
    errors.push(String(cause));
  }
  const durationMs = Math.round(performance.now() - start);
  await emit("pass_end", { ok: errors.length === 0, durationMs });
  return { job, ok: errors.length === 0, errors, durationMs };
}

/** What a driver needs from the outside world once a campaign actually runs. */
export interface PassExecutor {
  readonly journalPath: string;
  runPass(job: ReviewJob): Promise<JobResult>;
  /** Removes the scratch worktree base and prunes; called exactly once, in `finally`. */
  dispose(): Promise<void>;
}

export interface OpenOptions {
  /** Repository the commit lives in; the current directory unless a test says otherwise. */
  readonly repoDir?: string;
  /** The reviewer binary; `pi`, found on PATH, unless a test names a stand-in. */
  readonly piBinary?: string;
  /** The sealed review scope handed to every pass; none when coverage was not requested. */
  readonly reviewScope?: string;
}

/**
 * Prepare the effects of a campaign: output directory, the ephemeral per-run
 * HMAC key, the shared evidence digest and the scratch worktree base.
 */
export async function openCampaign(
  plan: ReviewPlan,
  options: OpenOptions = {},
): Promise<PassExecutor> {
  const repoDir = options.repoDir ?? ".";
  const piBinary = options.piBinary ?? "pi";
  await mkdir(plan.outputDir, { recursive: true });
  // Ephemeral per-run HMAC key for evidence integrity (K3 intra-run boundary).
  // Held in memory only, never logged or persisted. Identifies this orchestration run
  // and binds all evidence to it; an altered or stripped envelope is offline-verifiable.
  const envelopeKey: EnvelopeKey = {
    id: `fanout-run-${plan.commit.slice(0, 7)}-${randomUUID()}`,
    secret: getRandomValues(new Uint8Array(32)),
  };
  const evidenceDigest = await buildEvidenceDigest(
    plan,
    envelopeKey,
    repoDir,
    options.reviewScope ?? null,
  );
  const worktreeBase = await mkdtemp(join(tmpdir(), "review-fanout-"));
  const journalPath = join(plan.outputDir, "events.jsonl");
  return {
    journalPath,
    runPass: (job) =>
      runJob(
        plan,
        job,
        worktreeBase,
        evidenceDigest,
        journalWriter(journalPath, job),
        repoDir,
        piBinary,
      ),
    dispose: async () => {
      await rm(worktreeBase, { recursive: true, force: true });
      await git(["worktree", "prune"], repoDir);
    },
  };
}

/**
 * Replay the journal and check it against what the run itself observed.
 *
 * The journal is only worth keeping if it can stand in for the verdict files,
 * so every run verifies that claim: if the replayed status disagrees with the
 * in-memory result, the journal is wrong and says so loudly rather than being
 * trusted later by an auditor who has nothing else left to read.
 */
export async function reportJournal(
  journalPath: string,
  results: readonly JobResult[],
  io: CampaignIo = consoleIo,
): Promise<void> {
  const journal = Bun.file(journalPath);
  if (!(await journal.exists())) {
    io.error(`journal missing at ${journalPath} — the run produced no replayable trace`);
    return;
  }
  const { events, corrupted } = parseJournalLines(await journal.text());
  for (const entry of corrupted) {
    io.error(`journal line ${entry.line} unreadable (${entry.error}) — kept, not trusted`);
  }
  const replay = replayPassStatuses(events);
  io.log(`journal ${journalPath} — ${events.length} events across ${replay.length} pass(es)`);

  const observed = new Map(results.map((result) => [result.job.reviewPassId, result.ok]));
  for (const disagreement of reconcileReplay(replay, observed)) {
    io.error(
      `journal disagrees with the run on ${disagreement.role} (${disagreement.reviewPassId}): ` +
        `replayed ${disagreement.replayed}, observed ${
          disagreement.observedOk ? "success" : "fail"
        } — ${disagreement.reason}`,
    );
  }
}

/** One line per pass, then the failure count; returns how many passes failed. */
export function printResults(results: readonly JobResult[], io: CampaignIo = consoleIo): number {
  let failed = 0;
  for (const result of results) {
    if (result.ok) {
      io.log(`ok   ${result.job.role} (${result.durationMs} ms) → ${result.job.outputPath}`);
    } else {
      failed += 1;
      io.error(`FAIL ${result.job.role} (${result.durationMs} ms)`);
      for (const error of result.errors) io.error(`     ${error}`);
    }
  }
  if (failed > 0) io.error(`${failed}/${results.length} pass(es) failed`);
  return failed;
}

// ── Campaign drivers ─────────────────────────────────────────────────────────

export interface CampaignInput {
  readonly plan: ReviewPlan;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly makeId: () => string;
  readonly hasRecordedVerdict: (job: ReviewJob) => boolean;
  /** Called only when passes really run; never on a dry run, a refusal or an empty plan. */
  readonly open: (plan: ReviewPlan) => Promise<PassExecutor>;
  readonly verify: (journalPath: string, results: readonly JobResult[]) => Promise<void>;
  readonly io: CampaignIo;
}

/** What a campaign amounts to, whichever driver ran it. Closed: no driver state in here. */
export interface CampaignOutcome {
  readonly run: readonly ReviewJob[];
  readonly skipped: readonly ReviewJob[];
  /** Jobs a forced re-run would overwrite; non-empty means the campaign was refused. */
  readonly collisions: readonly ReviewJob[];
  readonly results: readonly JobResult[];
  readonly failed: number;
}

export interface PlannedCampaign {
  readonly run: ReviewJob[];
  readonly skipped: ReviewJob[];
  readonly collisions: ReviewJob[];
}

/** Which passes the plan calls for, which are already recorded, which a forced run would clobber. */
export function planCampaign(
  input: Pick<CampaignInput, "plan" | "force" | "makeId" | "hasRecordedVerdict">,
): PlannedCampaign {
  const jobs = buildJobs(input.plan, input.makeId);
  const { run, skipped } = dedupeJobs(jobs, input.hasRecordedVerdict, input.force);
  const collisions = input.force ? run.filter((job) => input.hasRecordedVerdict(job)) : [];
  return { run, skipped, collisions };
}

/** Whether passes should execute for this plan, given the flags. */
export function shouldExecute(
  planned: Pick<PlannedCampaign, "run" | "collisions">,
  dryRun: boolean,
): boolean {
  return !dryRun && planned.collisions.length === 0 && planned.run.length > 0;
}

/** The lines a campaign prints before any pass starts; identical for every driver. */
export function announceCampaign(
  planned: PlannedCampaign,
  input: Pick<CampaignInput, "plan" | "dryRun" | "io">,
): void {
  const { io, plan } = input;
  if (planned.collisions.length > 0) {
    io.error(
      "refusing to overwrite recorded verdicts (immutable audit records); archive them first:",
    );
    for (const job of planned.collisions) io.error(`- ${job.outputPath}`);
    return;
  }
  for (const job of planned.skipped) {
    io.log(`skip ${job.role}: verdict already recorded at ${job.outputPath}`);
  }
  if (planned.run.length === 0) {
    io.log("nothing to run");
    return;
  }
  io.log(
    `${planned.run.length} pass(es) on ${plan.commit.slice(0, 7)} — concurrency ${plan.concurrency}, ${plan.provider}/${plan.model}:${plan.thinking}`,
  );
  if (input.dryRun) {
    for (const job of planned.run) io.log(`- ${job.role} → ${job.outputPath}`);
  }
}

export function outcomeOf(
  planned: PlannedCampaign,
  results: readonly JobResult[],
): CampaignOutcome {
  return {
    run: planned.run,
    skipped: planned.skipped,
    collisions: planned.collisions,
    results,
    failed: results.filter((result) => !result.ok).length,
  };
}

/** The default driver: bounded-concurrency batches, no framework. */
export async function runCampaignDirect(input: CampaignInput): Promise<CampaignOutcome> {
  const planned = planCampaign(input);
  announceCampaign(planned, input);
  if (!shouldExecute(planned, input.dryRun)) return outcomeOf(planned, []);

  const executor = await input.open(input.plan);
  try {
    const results = await runBatched(planned.run, input.plan.concurrency, (job) =>
      executor.runPass(job),
    );
    await input.verify(executor.journalPath, results);
    return outcomeOf(planned, results);
  } finally {
    await executor.dispose();
  }
}

// ── Coverage (tools/review/fanout-coverage.ts) ───────────────────────────────
//
// The effects around the pure coverage module: reading the base tree, listing
// and reading the diff, writing the closed manifest. Every git call reaches
// paths as literal pathspecs and diffs with external diff drivers and textconv
// filters off, so the repository under review configures none of it.

export type GitRunner = (args: string[]) => Promise<string>;

export function gitIn(repoDir: string): GitRunner {
  return (args) => git(args, repoDir);
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"] as const;
const DIFF_READ_CONCURRENCY = 8;

/** A file at a revision; null when the revision has no such path, a throw when unreadable. */
export async function readAtRevision(
  runGit: GitRunner,
  revision: string,
  path: string,
): Promise<string | null> {
  assertReadable(path);
  const listing = await runGit([
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    "--name-only",
    revision,
    "--",
    path,
  ]);
  if (listing !== `${path}\0`) return null;
  return runGit(["cat-file", "blob", `${revision}:${path}`]);
}

/**
 * List the diff and read each file's patch, except a secret's: its patch is
 * never read, so its content reaches no fingerprint, no manifest and no prompt.
 */
export async function collectDiff(
  runGit: GitRunner,
  base: string,
  head: string,
): Promise<{ entries: DiffEntry[]; patches: Map<string, string> }> {
  const changes = parseNameStatusZ(
    await runGit(["--literal-pathspecs", "diff", "--name-status", "-z", ...DIFF_FLAGS, base, head]),
  );
  const patches = new Map<string, string>();
  const entries = await runBatched(changes, DIFF_READ_CONCURRENCY, async (change) => {
    const names = change.oldPath === null ? [change.path] : [change.oldPath, change.path];
    if (names.some(isSecretPath)) {
      return { ...change, binary: false, patchBytes: null, patchSha256: null };
    }
    const patch = await runGit([
      "--literal-pathspecs",
      "diff",
      ...DIFF_FLAGS,
      base,
      head,
      "--",
      ...names,
    ]);
    patches.set(change.path, patch);
    return describePatch(change, patch);
  });
  return { entries, patches };
}

export interface PreparedCoverage {
  readonly sealed: SealedManifest;
  readonly rules: ReviewRules;
  /** The patch of every sealed file, for anchoring findings; nothing else. */
  readonly patches: ReadonlyMap<string, string>;
}

/** Seal the review scope before any pass runs: rules from the base, diff base..commit. */
export async function prepareCoverage(
  plan: ReviewPlan,
  request: CoverageRequest,
  runGit: GitRunner,
): Promise<PreparedCoverage> {
  await runGit(["cat-file", "-e", `${request.base}^{commit}`]);
  const { rules, source } = await loadRulesAtBase(
    (revision, path) => readAtRevision(runGit, revision, path),
    request.base,
    request.rulesPath,
  );
  const { entries, patches } = await collectDiff(runGit, request.base, plan.commit);
  const sealed = sealManifest({
    base: request.base,
    head: plan.commit,
    selection: selectFiles(entries, rules),
    rules,
    rulesSource: source,
    reviewer: { provider: plan.provider, model: plan.model, thinking: plan.thinking },
    roles: plan.roles,
  });
  const sealedPatches = new Map<string, string>();
  for (const file of sealed.selected) {
    const patch = patches.get(file.path);
    if (patch === undefined) throw new Error(`no patch read for sealed path ${file.path}`);
    sealedPatches.set(file.path, patch);
  }
  return { sealed, rules, patches: sealedPatches };
}

export const COVERAGE_MANIFEST_NAME = "coverage.manifest.json";

function isClosedManifest(value: unknown): value is ClosedManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === "fanout-coverage-manifest.v1" &&
    typeof record.reviewId === "string" &&
    typeof record.status === "string" &&
    Array.isArray(record.roles) &&
    record.roles.every((role) => typeof role === "string")
  );
}

async function readPriorManifest(path: string, io: CampaignIo): Promise<ClosedManifest | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const value: unknown = JSON.parse(await file.text());
    if (isClosedManifest(value)) return value;
  } catch {
    // Reported below with the shape failure: both mean the prior attests nothing.
  }
  io.error(`prior coverage manifest at ${path} is unreadable — not trusted, nothing is reused`);
  return null;
}

/**
 * Close and write the manifest after the passes. A review is declared complete
 * only by a complete manifest; the closure line carries every counter.
 */
export async function concludeCoverage(
  prepared: PreparedCoverage,
  outcome: CampaignOutcome,
  outputDir: string,
  io: CampaignIo = consoleIo,
): Promise<ClosedManifest> {
  const path = join(outputDir, COVERAGE_MANIFEST_NAME);
  const prior = await readPriorManifest(path, io);
  const outcomes = settleFromCampaign(prepared.sealed, {
    executed: outcome.results.map((result) => ({ role: result.job.role, ok: result.ok })),
    skippedRoles: outcome.skipped.map((job) => job.role),
    prior,
  });
  const closed = closeManifest(prepared.sealed, outcomes, { budgetExhausted: false });
  await mkdir(outputDir, { recursive: true });
  await Bun.write(path, `${JSON.stringify(closed, null, 2)}\n`);
  const line = `${formatClosure(closed)} → ${path}`;
  if (closed.status === "complete") io.log(line);
  else io.error(`${line} — this review is not declared complete`);
  return closed;
}
