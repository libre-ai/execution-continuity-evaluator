import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  disposeFixture,
  type Fixture,
  fixtureGit,
  makeFixture,
  normalizeOutput,
  piInvocations,
  runCli,
  runRealCampaign,
  setFakePiMode,
  worktreeCount,
} from "./fanout-fixtures";
import { type CampaignOutcome, campaignExitCode, printResults } from "./fanout-run";

// The observable contract of `fanout.ts` (EF-10): same plan in, same verdicts,
// same append-only journal, worktrees removed in `finally`. These tests run the
// real CLI against a throwaway repository and a stand-in `pi`, so they pin the
// path that exists without the LangGraph package (CA-29).
//
// Until a pass is confined to its worktree (CA-32, sixth activation condition),
// the default driver refuses real passes and nothing on the command line lifts
// that: the CLI tests pin the refusal and everything that runs no pass; what a
// real campaign records is pinned in process, through the default driver and
// the table reserved for tests, then printed as the command line prints it.

const fixtures: Fixture[] = [];
async function fixture(roles?: readonly string[]): Promise<Fixture> {
  const created = await makeFixture(roles);
  fixtures.push(created);
  return created;
}
afterEach(async () => {
  for (const created of fixtures.splice(0)) await disposeFixture(created);
});

/** A verdict file planted where the plan records one, as if a pass had run. */
async function plantVerdict(f: Fixture, role: string): Promise<void> {
  await mkdir(f.outputDir, { recursive: true });
  await writeFile(join(f.outputDir, `${role}.verdict.json`), "{}\n");
}

function printed(results: Parameters<typeof printResults>[0]) {
  const lines: string[] = [];
  const failed = printResults(results, {
    log: (line) => lines.push(`log: ${line}`),
    error: (line) => lines.push(`err: ${line}`),
  });
  return { failed, text: lines.join("\n") };
}

describe("fanout.ts (default path)", () => {
  test("a real campaign is refused while a pass is not confined, and touches nothing", async () => {
    const f = await fixture();
    const result = await runCli(f, [f.planPath]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("the default runtime does not run real review passes yet");
    expect(result.stderr).toContain("- pass-read-confined:");
    expect(result.stderr).toContain("--dry-run is available on this runtime");
    expect(await piInvocations(f)).toEqual([]);
    expect(existsSync(f.outputDir)).toBe(false);
    expect(await worktreeCount(f)).toBe(1);
  });

  test("no flag and no environment variable lifts the refusal", async () => {
    const f = await fixture();
    const result = await runCli(f, [f.planPath, "--force"], {
      env: { PASS_READ_CONFINED: "1", ACTIVATE: "true", NODE_ENV: "production" },
    });
    expect(result.exitCode).toBe(2);
    expect(await piInvocations(f)).toEqual([]);
  });

  test("--dry-run lists the passes, runs no pi, writes nothing", async () => {
    const f = await fixture();
    const result = await runCli(f, [f.planPath, "--dry-run"]);

    expect(result.exitCode).toBe(0);
    expect(normalizeOutput(result.stdout, f)).toBe(
      [
        `2 pass(es) on ${f.commit.slice(0, 7)} — concurrency 2, fake-provider/fake-model:off`,
        "- alpha → out/verdicts/alpha.verdict.json",
        "- beta → out/verdicts/beta.verdict.json",
        "",
      ].join("\n"),
    );
    expect(await piInvocations(f)).toEqual([]);
    expect(existsSync(f.outputDir)).toBe(false);
  });

  test("a recorded verdict is skipped, and nothing runs when all are recorded", async () => {
    const f = await fixture(["alpha"]);
    await plantVerdict(f, "alpha");
    const again = await runCli(f, [f.planPath]);

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("skip alpha: verdict already recorded at");
    expect(again.stdout).toContain("nothing to run");
    expect(await piInvocations(f)).toEqual([]);
  });

  test("--force refuses to overwrite a recorded verdict", async () => {
    const f = await fixture(["alpha"]);
    await plantVerdict(f, "alpha");
    const forced = await runCli(f, [f.planPath, "--force"]);

    expect(forced.exitCode).toBe(2);
    expect(forced.stderr).toContain("refusing to overwrite recorded verdicts");
    expect(await piInvocations(f)).toEqual([]);
  });

  test("a commit that does not exist is refused before any pass", async () => {
    const f = await fixture(["alpha"]);
    const plan = await Bun.file(f.planPath).json();
    await Bun.write(f.planPath, JSON.stringify({ ...plan, commit: "1".repeat(40) }));
    const result = await runCli(f, [f.planPath]);

    expect(result.exitCode).not.toBe(0);
    expect(await piInvocations(f)).toEqual([]);
  });

  test("no plan is a usage error", async () => {
    const f = await fixture();
    const result = await runCli(f, []);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: bun tools/review/fanout.ts");
  });

  test("the fixture repository is untouched by a refused campaign", async () => {
    const f = await fixture(["alpha"]);
    await runCli(f, [f.planPath]);
    expect(await fixtureGit(f.dir, ["status", "--porcelain"])).toBe("");
  });
});

describe("the default driver with real effects, printed as the command line prints", () => {
  test("a real campaign records one verdict per role and a replayable journal", async () => {
    const f = await fixture();
    const campaign = await runRealCampaign(f, "direct", "verdicts");

    expect(campaign.outputFiles).toEqual([
      "alpha.verdict.json",
      "beta.verdict.json",
      "events.jsonl",
    ]);
    const verdict = await Bun.file(join(campaign.outputDir, "alpha.verdict.json")).json();
    expect(verdict.role).toBe("alpha");
    expect(verdict.commitSha).toBe(f.commit);
    expect(verdict.runner.orchestrator).toBe("tools/review/fanout.ts");
    const alpha = campaign.journal.filter((event) => event.role === "alpha").map((e) => e.type);
    expect(alpha).toEqual([
      "pass_start",
      "worktree_ready",
      "agent_call",
      "verdict_recorded",
      "worktree_removed",
      "pass_end",
    ]);
    expect(campaign.lines.join("\n")).toContain("2 pass(es) on");
    expect(campaign.lines.join("\n")).toContain("events across 2 pass(es)");
    const { failed, text } = printed(campaign.outcome.results);
    expect(failed).toBe(0);
    expect(text).toMatch(/ok {3}alpha \(\d+ ms\)/);
    expect(await worktreeCount(f)).toBe(1);
  });

  test("a failing pass fails the run, records no verdict and still removes its worktree", async () => {
    const f = await fixture(["alpha"]);
    await setFakePiMode(f, "exit1");
    const campaign = await runRealCampaign(f, "direct", "verdicts");
    const { failed, text } = printed(campaign.outcome.results);

    expect(failed).toBe(1);
    expect(text).toContain("FAIL alpha");
    expect(text).toContain("pi exited 1");
    expect(text).toContain("1/1 pass(es) failed");
    expect(existsSync(join(campaign.outputDir, "alpha.verdict.json"))).toBe(false);
    expect(await worktreeCount(f)).toBe(1);
  });

  test("a reviewer that writes to its tree invalidates the pass", async () => {
    const f = await fixture(["alpha"]);
    await setFakePiMode(f, "dirty");
    const campaign = await runRealCampaign(f, "direct", "verdicts");

    expect(printed(campaign.outcome.results).text).toContain("worktree dirty after review pass");
    expect(campaign.journal.map((event) => event.type)).toContain("worktree_dirty");
    expect(existsSync(join(campaign.outputDir, "alpha.verdict.json"))).toBe(false);
  });

  test("the fixture repository is untouched by a campaign", async () => {
    const f = await fixture(["alpha"]);
    await runRealCampaign(f, "direct", "verdicts");
    expect(await fixtureGit(f.dir, ["status", "--porcelain"])).toBe("");
  });
});

// The exit status is decided by campaignExitCode alone, and main applies it:
// pinned without a real pass, since the command line refuses them (CA-32).
describe("the exit code policy of the command line", () => {
  const job = {
    reviewPassId: "rp-1",
    subject: "s",
    commit: "f".repeat(40),
    role: "alpha",
    mode: "specialized-role",
    outputPath: "out/alpha.verdict.json",
  } as const;
  const ok = { job, ok: true, errors: [], durationMs: 1 };
  const ko = { job, ok: false, errors: ["pi exited 1: x"], durationMs: 1 };
  const outcome = (fields: Partial<CampaignOutcome>): CampaignOutcome => ({
    run: [job],
    skipped: [],
    collisions: [],
    results: [ok],
    failed: 0,
    ...fields,
  });

  test.each([
    ["every pass succeeded", outcome({}), 0],
    ["nothing to run", outcome({ run: [], results: [] }), 0],
    ["one pass failed", outcome({ results: [ok, ko], failed: 1 }), 1],
    ["every pass failed", outcome({ results: [ko], failed: 1 }), 1],
    ["a forced re-run collides", outcome({ run: [], results: [], collisions: [job] }), 2],
    ["a collision and a failure", outcome({ collisions: [job], results: [ko], failed: 1 }), 2],
    ["a driver refused real passes", "activation-refused", 2],
  ] as const)("%s: the exit code the policy gives", (_name, end, code) => {
    expect(campaignExitCode(end)).toBe(code);
  });

  test("main exits through the policy, and only through it, once a campaign ends", async () => {
    const cli = await Bun.file(join(import.meta.dir, "fanout.ts")).text();
    const lines = cli.split("\n");
    expect(lines.filter((line) => line.includes("campaignExitCode(outcome)"))).toHaveLength(1);
    expect(
      lines.filter((line) => line.includes('campaignExitCode("activation-refused")')),
    ).toHaveLength(2);
    expect(
      lines.filter((line) => /if \(code !== 0\) process\.exit\(code\)/.test(line)),
    ).toHaveLength(1);
    expect(lines.filter((line) => /process\.exit\(1\)/.test(line))).toEqual([]);
  });
});
