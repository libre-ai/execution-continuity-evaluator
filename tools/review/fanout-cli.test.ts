import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  disposeFixture,
  type Fixture,
  fixtureGit,
  makeFixture,
  normalizeOutput,
  piInvocations,
  runCli,
  worktreeCount,
} from "./fanout-fixtures";

// The observable contract of `fanout.ts` (EF-10): same plan in, same verdicts,
// same append-only journal, worktrees removed in `finally`. These tests run the
// real CLI against a throwaway repository and a stand-in `pi`, so they pin the
// path that exists without the LangGraph package (CA-29).

const fixtures: Fixture[] = [];
async function fixture(roles?: readonly string[]): Promise<Fixture> {
  const created = await makeFixture(roles);
  fixtures.push(created);
  return created;
}
afterEach(async () => {
  for (const created of fixtures.splice(0)) await disposeFixture(created);
});

async function journalOf(f: Fixture): Promise<{ role: string; type: string }[]> {
  const text = await Bun.file(join(f.outputDir, "events.jsonl")).text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { role: string; type: string });
}

describe("fanout.ts (default path)", () => {
  test("a real campaign records one verdict per role and a replayable journal", async () => {
    const f = await fixture();
    const result = await runCli(f, [f.planPath]);

    expect(result.exitCode).toBe(0);
    expect(readdirSync(f.outputDir).sort()).toEqual([
      "alpha.verdict.json",
      "beta.verdict.json",
      "events.jsonl",
    ]);
    const verdict = await Bun.file(join(f.outputDir, "alpha.verdict.json")).json();
    expect(verdict.role).toBe("alpha");
    expect(verdict.commitSha).toBe(f.commit);
    expect(verdict.runner.orchestrator).toBe("tools/review/fanout.ts");

    const events = await journalOf(f);
    const alpha = events.filter((event) => event.role === "alpha").map((event) => event.type);
    expect(alpha).toEqual([
      "pass_start",
      "worktree_ready",
      "agent_call",
      "verdict_recorded",
      "worktree_removed",
      "pass_end",
    ]);
    expect(result.stdout).toContain("2 pass(es) on");
    expect(result.stdout).toContain("events across 2 pass(es)");
    expect(result.stdout).toMatch(/ok {3}alpha \(\d+ ms\)/);
    expect(await worktreeCount(f)).toBe(1);
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

  test("a failing pass fails the run, records no verdict and still removes its worktree", async () => {
    const f = await fixture(["alpha"]);
    const result = await runCli(f, [f.planPath], { env: { FAKE_PI_MODE: "exit1" } });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("FAIL alpha");
    expect(result.stderr).toContain("pi exited 1");
    expect(result.stderr).toContain("1/1 pass(es) failed");
    expect(existsSync(join(f.outputDir, "alpha.verdict.json"))).toBe(false);
    expect(await worktreeCount(f)).toBe(1);
  });

  test("a reviewer that writes to its tree invalidates the pass", async () => {
    const f = await fixture(["alpha"]);
    const result = await runCli(f, [f.planPath], { env: { FAKE_PI_MODE: "dirty" } });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("worktree dirty after review pass");
    expect((await journalOf(f)).map((event) => event.type)).toContain("worktree_dirty");
    expect(existsSync(join(f.outputDir, "alpha.verdict.json"))).toBe(false);
  });

  test("a recorded verdict is skipped, and nothing runs when all are recorded", async () => {
    const f = await fixture(["alpha"]);
    expect((await runCli(f, [f.planPath])).exitCode).toBe(0);
    const again = await runCli(f, [f.planPath]);

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("skip alpha: verdict already recorded at");
    expect(again.stdout).toContain("nothing to run");
    expect((await piInvocations(f)).length).toBe(1);
  });

  test("--force refuses to overwrite a recorded verdict", async () => {
    const f = await fixture(["alpha"]);
    expect((await runCli(f, [f.planPath])).exitCode).toBe(0);
    const forced = await runCli(f, [f.planPath, "--force"]);

    expect(forced.exitCode).toBe(2);
    expect(forced.stderr).toContain("refusing to overwrite recorded verdicts");
    expect((await piInvocations(f)).length).toBe(1);
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

  test("the fixture repository is untouched by a campaign", async () => {
    const f = await fixture(["alpha"]);
    await runCli(f, [f.planPath]);
    expect(await fixtureGit(f.dir, ["status", "--porcelain"])).toBe("");
  });
});
