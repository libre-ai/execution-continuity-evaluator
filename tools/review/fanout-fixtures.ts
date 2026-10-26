import { existsSync, readdirSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ActivationCondition, LANGGRAPH_ACTIVATION_CONDITIONS } from "./fanout-activation";
import { parsePlan, type ReviewEvent } from "./fanout-core";
import { runCampaignGraph } from "./fanout-graph";
import {
  type CampaignInput,
  type CampaignIo,
  type CampaignOutcome,
  openCampaign,
  reportJournal,
  runCampaignDirect,
} from "./fanout-run";

// Test support for the fan-out CLI: a throwaway git repository, a stand-in for
// the `pi` binary, and a way to run `fanout.ts` against both. Nothing here is
// imported by the orchestrator itself.

const FANOUT_PATH = join(import.meta.dir, "fanout.ts");

/**
 * The activation table with every condition marked met, for the tests that pin
 * what the drivers do with real passes (against scripted executors or a
 * stand-in `pi`). It proves nothing: every condition names the INV-a vector,
 * only because a proof must be a test file of tools/review/vectors/
 * (fanout-activation.ts); no orchestrator source may import it
 * (authority-boundary.test.ts).
 */
export const ALL_CONDITIONS_MET_FOR_TESTS: readonly ActivationCondition[] =
  LANGGRAPH_ACTIVATION_CONDITIONS.map((condition) => ({
    ...condition,
    satisfied: true,
    evidence: "tools/review/vectors/inv-a-read-only-passes.test.ts",
  }));

export interface Fixture {
  readonly dir: string;
  readonly commit: string;
  readonly outputDir: string;
  readonly planPath: string;
  readonly binDir: string;
  /** The stand-in reviewer, by absolute path. */
  readonly piBinary: string;
  readonly piLog: string;
  /** `fanout.ts` copied to a place where no @langchain/* package resolves. */
  readonly fanoutWithoutPackage: string;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  argv: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<CliResult> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env ?? (process.env as Record<string, string>),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function git(dir: string, args: string[]): Promise<string> {
  const result = await run(
    [
      "git",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { cwd: dir },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// The stand-in reads the four literals the prompt pins ("exactly ...") and
// answers with a verdict that carries them back. The failure shape comes from
// FAKE_PI_MODE, or else from the file "mode" next to the stand-in (for a caller
// that cannot set the environment of the process); FAKE_PI_LOG, or else
// "../pi.log", receives one JSON line per invocation, prompt included. Mode
// "reply" prints the file "reply" next to the stand-in, its {{reviewPassId}},
// {{role}}, {{mode}} and {{commitSha}} replaced by the pinned literals: a
// hostile reviewer scripted byte for byte (tools/review/vectors).
const FAKE_PI_SOURCE = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const here = dirname(process.argv[1]);
const prompt = process.argv.at(-1) ?? "";
const log = process.env.FAKE_PI_LOG ?? join(here, "..", "pi.log");
appendFileSync(
  log,
  JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2, -1), prompt }) + "\\n",
);
const literal = (name) => new RegExp(name + ' \\\\(exactly "([^"]+)"\\\\)').exec(prompt)?.[1];
const modeFile = join(here, "mode");
const mode =
  process.env.FAKE_PI_MODE ?? (existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "approve");
if (mode === "reply") {
  let reply = readFileSync(join(here, "reply"), "utf8");
  for (const name of ["reviewPassId", "role", "mode", "commitSha"]) {
    reply = reply.replaceAll("{{" + name + "}}", literal(name) ?? "");
  }
  console.log(reply);
  const stderrFile = join(here, "reply-stderr");
  if (existsSync(stderrFile)) process.stderr.write(readFileSync(stderrFile, "utf8"));
  const exitFile = join(here, "reply-exit");
  process.exit(existsSync(exitFile) ? Number(readFileSync(exitFile, "utf8")) : 0);
}
if (mode === "exit1") {
  console.error("fake pi: provider refused");
  process.exit(1);
}
if (mode === "dirty") writeFileSync("written-by-reviewer.txt", "x");
if (mode === "no-block") {
  console.log("no verdict here");
  process.exit(0);
}
const verdict = {
  reviewPassId: literal("reviewPassId"),
  role: literal("role"),
  mode: literal("mode"),
  commitSha: literal("commitSha"),
  contractHashes: [],
  commands: ["git status"],
  findings: { blocking: [], major: [], minor: [], nonBlocking: [] },
  residualRisks: [],
  verdict: "approve",
};
console.log("review done\\n\\n\`\`\`json\\n" + JSON.stringify(verdict) + "\\n\`\`\`");
`;

// A copy of the orchestrator sources next to a node_modules that holds every
// dependency of tools/review except @langchain/*: the layout of a checkout
// where the package was never installed (or was removed, ADR-0058 section 4).
// Symlinks, not copies, so the other packages resolve exactly as they do here.
async function installToolWithoutPackage(dir: string): Promise<string> {
  const toolDir = join(dir, "tool-without-package");
  await mkdir(join(toolDir, "node_modules"), { recursive: true });
  for (const name of readdirSync(import.meta.dir)) {
    if (
      /^fanout.*\.ts$/.test(name) &&
      !name.endsWith(".test.ts") &&
      name !== "fanout-fixtures.ts"
    ) {
      await copyFile(join(import.meta.dir, name), join(toolDir, name));
    }
  }
  const installed = join(import.meta.dir, "node_modules");
  for (const name of readdirSync(installed)) {
    if (name === "@langchain") continue;
    await symlink(join(installed, name), join(toolDir, "node_modules", name));
  }
  return join(toolDir, "fanout.ts");
}

export async function makeFixture(roles: readonly string[] = ["alpha", "beta"]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "fanout-fixture-"));
  await git(dir, ["init", "--quiet"]);
  await writeFile(join(dir, "subject.txt"), "subject under review\n");
  // resolveReviewProtocol only checks that the governance protocol file exists.
  const protocol = join(
    dir,
    "node_modules/@libre-ai/governance/docs/reviews/AGENT-REVIEW-PROTOCOL.md",
  );
  await mkdir(dirname(protocol), { recursive: true });
  await writeFile(protocol, "# protocol stand-in\n");
  await writeFile(
    join(dir, ".gitignore"),
    "node_modules/\nout/\nbin/\npi.log\nplan.json\nmeasure-*.json\ntool-without-package/\n",
  );
  await git(dir, ["add", "subject.txt", ".gitignore"]);
  await git(dir, ["commit", "--quiet", "-m", "fixture"]);
  const commit = await git(dir, ["rev-parse", "HEAD"]);

  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const pi = join(binDir, "pi");
  await writeFile(pi, FAKE_PI_SOURCE);
  await chmod(pi, 0o755);

  // The plan names its output directory relative to the repository, as
  // parsePlan requires; `Fixture.outputDir` is the same place, absolute, for
  // the tests that read it.
  const outputDir = join(dir, "out", "verdicts");
  const planPath = join(dir, "plan.json");
  await writeFile(
    planPath,
    JSON.stringify({
      subject: "fixture-subject",
      commit,
      roles,
      mode: "specialized-role",
      evidence: ["subject.txt"],
      concurrency: 2,
      provider: "fake-provider",
      model: "fake-model",
      thinking: "off",
      outputDir: "out/verdicts",
    }),
  );
  return {
    dir,
    commit,
    outputDir,
    planPath,
    binDir,
    piBinary: pi,
    piLog: join(dir, "pi.log"),
    fanoutWithoutPackage: await installToolWithoutPackage(dir),
  };
}

/** Environment for a child process: the fake `pi` first on PATH. */
export function fixtureEnv(
  fixture: Fixture,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? fixture.dir,
    FAKE_PI_LOG: fixture.piLog,
    ...extra,
  };
}

export interface CliOptions {
  /** Added to the child's environment (the fixture's PATH and HOME are always there). */
  readonly env?: Record<string, string>;
  /** Run the orchestrator from a layout where no `@langchain/*` package is installed. */
  readonly packageAbsent?: boolean;
  /** Exactly this environment, nothing of the fixture's: `env -i PATH=$PATH`. */
  readonly bareEnv?: boolean;
}

export async function runCli(
  fixture: Fixture,
  args: readonly string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const entry = options.packageAbsent ? fixture.fanoutWithoutPackage : FANOUT_PATH;
  return run([process.execPath, entry, ...args], {
    cwd: fixture.dir,
    env: options.bareEnv
      ? { PATH: `${fixture.binDir}:${process.env.PATH ?? ""}` }
      : fixtureEnv(fixture, options.env),
  });
}

/** Choose how the stand-in behaves for callers that run in this process, not in a child. */
export async function setFakePiMode(fixture: Fixture, mode: string): Promise<void> {
  await writeFile(join(fixture.binDir, "mode"), mode);
}

/**
 * Script the stand-in's whole reply, for callers that run in this process:
 * its standard output, and optionally its error output and exit code.
 */
export async function setFakePiReply(
  fixture: Fixture,
  reply: string,
  options: { readonly stderr?: string; readonly exitCode?: number } = {},
): Promise<void> {
  await writeFile(join(fixture.binDir, "reply"), reply);
  await rm(join(fixture.binDir, "reply-stderr"), { force: true });
  await rm(join(fixture.binDir, "reply-exit"), { force: true });
  if (options.stderr !== undefined) {
    await writeFile(join(fixture.binDir, "reply-stderr"), options.stderr);
  }
  if (options.exitCode !== undefined) {
    await writeFile(join(fixture.binDir, "reply-exit"), String(options.exitCode));
  }
  await setFakePiMode(fixture, "reply");
}

export interface PiInvocation {
  readonly cwd: string;
  /** Every argument but the last, which is the prompt. */
  readonly argv: string[];
  readonly prompt: string;
}

/** `pi` invocations the fixture recorded, one parsed record per run. */
export async function piInvocations(fixture: Fixture): Promise<PiInvocation[]> {
  const log = Bun.file(fixture.piLog);
  if (!(await log.exists())) return [];
  return (await log.text())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

export async function worktreeCount(fixture: Fixture): Promise<number> {
  const listing = await git(fixture.dir, ["worktree", "list", "--porcelain"]);
  return listing.split("\n").filter((line) => line.startsWith("worktree ")).length;
}

/** Strip what legitimately differs between two runs of the same campaign. */
export function normalizeOutput(text: string, fixture: Fixture): string {
  return text
    .replaceAll(realpathSync(fixture.dir), "<fixture>")
    .replaceAll(fixture.dir, "<fixture>")
    .replace(/\(\d+ ms\)/g, "(N ms)")
    .replace(/rp-[0-9a-f]{7}-[0-9a-f-]{36}/g, "<pass-id>");
}

export const fixtureGit = git;

export type DriverName = "direct" | "graph";
export const DRIVERS: DriverName[] = ["direct", "graph"];

/** What a campaign with real effects left behind, seen from outside the orchestrator. */
export interface RealCampaign {
  readonly outcome: CampaignOutcome;
  /** The output directory as the plan names it, relative to the fixture repository. */
  readonly planOutputDir: string;
  /** The same directory, absolute. */
  readonly outputDir: string;
  /** Names of the files in the output directory after the run, sorted. */
  readonly outputFiles: string[];
  readonly journalText: string;
  readonly journal: ReviewEvent[];
  /** The `pi` invocations of this campaign only, not of earlier ones on the fixture. */
  readonly invocations: PiInvocation[];
  readonly lines: string[];
}

/**
 * Run the fixture's plan through one driver with every real effect: git
 * worktrees, the stand-in `pi` named by path, the journal and the verdict
 * files. The graph driver gets the table marked met, as in
 * fanout-graph-real.test.ts: what is pinned is its behaviour, not its activation.
 */
export async function runRealCampaign(
  fixture: Fixture,
  driver: DriverName,
  outputName: string,
): Promise<RealCampaign> {
  const planOutputDir = `out/${outputName}`;
  const outputDir = join(fixture.dir, planOutputDir);
  const plan = parsePlan({
    ...(await Bun.file(fixture.planPath).json()),
    outputDir: planOutputDir,
  });
  const lines: string[] = [];
  const io: CampaignIo = {
    log: (line) => lines.push(`log: ${line}`),
    error: (line) => lines.push(`err: ${line}`),
  };
  const before = (await piInvocations(fixture)).length;
  let counter = 0;
  const input: CampaignInput = {
    plan,
    force: false,
    dryRun: false,
    makeId: () => {
      counter += 1;
      return `rp-${outputName}-${counter}`;
    },
    hasRecordedVerdict: (job) => existsSync(join(fixture.dir, job.outputPath)),
    open: (campaignPlan) =>
      openCampaign(campaignPlan, { repoDir: fixture.dir, piBinary: fixture.piBinary }),
    verify: (journalPath, results) => reportJournal(journalPath, results, io),
    io,
  };
  const outcome =
    driver === "direct"
      ? await runCampaignDirect(input)
      : await runCampaignGraph(input, ALL_CONDITIONS_MET_FOR_TESTS);
  const journalPath = join(outputDir, "events.jsonl");
  const journalText = existsSync(journalPath) ? await Bun.file(journalPath).text() : "";
  return {
    outcome,
    planOutputDir,
    outputDir,
    outputFiles: existsSync(outputDir) ? readdirSync(outputDir).sort() : [],
    journalText,
    journal: journalText
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ReviewEvent),
    invocations: (await piInvocations(fixture)).slice(before),
    lines,
  };
}

export async function disposeFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.dir, { recursive: true, force: true });
}
