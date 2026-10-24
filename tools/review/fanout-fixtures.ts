import { readdirSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ActivationCondition, LANGGRAPH_ACTIVATION_CONDITIONS } from "./fanout-activation";

// Test support for the fan-out CLI: a throwaway git repository, a stand-in for
// the `pi` binary, and a way to run `fanout.ts` against both. Nothing here is
// imported by the orchestrator itself.

const FANOUT_PATH = join(import.meta.dir, "fanout.ts");

/**
 * The activation table with every condition marked met, for the tests that pin
 * what the graph driver does with real passes (against scripted executors or a
 * stand-in `pi`). It proves nothing: the evidence it names is this test support
 * file, and no orchestrator source may import it (authority-boundary.test.ts).
 */
export const ALL_CONDITIONS_MET_FOR_TESTS: readonly ActivationCondition[] =
  LANGGRAPH_ACTIVATION_CONDITIONS.map((condition) => ({
    ...condition,
    satisfied: true,
    evidence: "tools/review/fanout-fixtures.ts",
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
// "../pi.log", receives one JSON line per invocation.
const FAKE_PI_SOURCE = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const here = dirname(process.argv[1]);
const prompt = process.argv.at(-1) ?? "";
const log = process.env.FAKE_PI_LOG ?? join(here, "..", "pi.log");
appendFileSync(log, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2, -1) }) + "\\n");
const literal = (name) => new RegExp(name + ' \\\\(exactly "([^"]+)"\\\\)').exec(prompt)?.[1];
const modeFile = join(here, "mode");
const mode =
  process.env.FAKE_PI_MODE ?? (existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "approve");
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
      outputDir,
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

/** `pi` invocations the fixture recorded, one parsed record per run. */
export async function piInvocations(fixture: Fixture): Promise<{ cwd: string; argv: string[] }[]> {
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

export async function disposeFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.dir, { recursive: true, force: true });
}
