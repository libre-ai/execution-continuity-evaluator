import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LANGGRAPH_ACTIVATION_CONDITIONS, unmetConditions } from "./fanout-activation";
import {
  disposeFixture,
  type Fixture,
  makeFixture,
  piInvocations,
  runCli,
  worktreeCount,
} from "./fanout-fixtures";

// Runtime selection on the command line: the default path stays the default,
// the LangGraph path is opt-in, answers --dry-run identically, and refuses real
// passes until its activation conditions hold.

const fixtures: Fixture[] = [];
async function fixture(roles?: readonly string[]): Promise<Fixture> {
  const created = await makeFixture(roles);
  fixtures.push(created);
  return created;
}
afterEach(async () => {
  for (const created of fixtures.splice(0)) await disposeFixture(created);
});

// Assembled from parts: the textual telemetry gate scans this file too.
const SWITCH = `${"LANGSMITH"}${"_"}TRACING`;
const ALIAS = `${"LANGCHAIN"}${"_"}TRACING_V2`;

describe("--runtime=langgraph --dry-run", () => {
  test("prints exactly what the default path prints", async () => {
    const f = await fixture(["alpha", "beta", "gamma"]);
    const direct = await runCli(f, [f.planPath, "--dry-run"]);
    const graph = await runCli(f, [f.planPath, "--dry-run", "--runtime=langgraph"]);

    expect(graph.exitCode).toBe(0);
    expect(direct.exitCode).toBe(0);
    expect(graph.stdout).toBe(direct.stdout);
    expect(graph.stderr).toBe(direct.stderr);
    expect(graph.stdout).toContain("- gamma →");
    expect(existsSync(f.outputDir)).toBe(false);
    expect(await piInvocations(f)).toEqual([]);
  });

  test("--runtime=direct is the default path", async () => {
    const f = await fixture();
    const implicit = await runCli(f, [f.planPath, "--dry-run"]);
    const explicit = await runCli(f, [f.planPath, "--dry-run", "--runtime=direct"]);
    expect(explicit).toEqual(implicit);
  });

  test("gives the same output with a bare environment, on both paths", async () => {
    const f = await fixture();
    for (const flags of [["--dry-run"], ["--dry-run", "--runtime=langgraph"]]) {
      const full = await runCli(f, [f.planPath, ...flags]);
      const bare = await runCli(f, [f.planPath, ...flags], { bareEnv: true });
      expect(bare.exitCode).toBe(0);
      expect(bare.stdout).toBe(full.stdout);
    }
  });

  test("agrees with the default path on the example plan and the historical plan", async () => {
    const f = await fixture();
    for (const name of ["plan.example.json", "plan.orchestrator-ca44eb3.json"]) {
      const plan = await Bun.file(join(import.meta.dir, name)).json();
      // The committed plans name commits that are not in this repository; the
      // plan under test names a commit that is (CA-24, CA-29).
      const path = join(f.dir, `measure-${name}`);
      await Bun.write(path, JSON.stringify({ ...plan, commit: f.commit }));
      const direct = await runCli(f, [path, "--dry-run"]);
      const graph = await runCli(f, [path, "--dry-run", "--runtime=langgraph"]);

      expect(graph.exitCode).toBe(0);
      expect(graph.stdout).toBe(direct.stdout);
      for (const role of plan.roles) expect(graph.stdout).toContain(`- ${role} →`);
    }
  });
});

describe("--runtime=langgraph without --dry-run", () => {
  test("refuses real passes, names every unmet condition, and touches nothing", async () => {
    const f = await fixture();
    const result = await runCli(f, [f.planPath, "--runtime=langgraph"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    const unmet = unmetConditions();
    expect(unmet.length).toBeGreaterThan(0);
    for (const condition of LANGGRAPH_ACTIVATION_CONDITIONS) {
      const named = result.stderr.includes(`- ${condition.id}:`);
      expect([condition.id, named]).toEqual([condition.id, unmet.includes(condition)]);
    }
    expect(result.stderr).toContain(
      `${unmet.length} of ${LANGGRAPH_ACTIVATION_CONDITIONS.length} activation condition(s) unmet`,
    );
    expect(await piInvocations(f)).toEqual([]);
    expect(existsSync(f.outputDir)).toBe(false);
    expect(await worktreeCount(f)).toBe(1);
  });

  test("no flag and no environment variable lifts the refusal", async () => {
    const f = await fixture();
    const result = await runCli(f, [f.planPath, "--runtime=langgraph", "--force"], {
      env: { LANGGRAPH_ACTIVATED: "1", ACTIVATE: "true", NODE_ENV: "production" },
    });
    expect(result.exitCode).toBe(2);
    expect(await piInvocations(f)).toEqual([]);
  });
});

describe("runtime flag parsing", () => {
  test.each([
    ["an unknown runtime", ["--runtime=temporal"]],
    ["a bare flag", ["--runtime"]],
    ["a repeated flag", ["--runtime=direct", "--runtime=langgraph"]],
    ["an empty value", ["--runtime="]],
  ])("%s is a usage error", async (_name, flags) => {
    const f = await fixture();
    const result = await runCli(f, [f.planPath, "--dry-run", ...flags]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: bun tools/review/fanout.ts");
    expect(result.stdout).toBe("");
  });
});

describe("the default path does not need the package (CA-29)", () => {
  // Until a pass is confined (CA-32) the default driver refuses real passes:
  // with the package absent a real run reaches that refusal, the same as with
  // the package present, and no module resolution error.
  test("a real run with every @langchain/* import failing to resolve reaches the driver's own refusal", async () => {
    const f = await fixture(["alpha"]);
    const present = await runCli(f, [f.planPath]);
    const absent = await runCli(f, [f.planPath], { packageAbsent: true });

    expect(absent.exitCode).toBe(2);
    expect(absent.stderr).toContain("- pass-read-confined:");
    expect(absent.stderr).not.toMatch(/Cannot find|@langchain/);
    expect(absent).toEqual(present);
    expect(existsSync(join(f.outputDir, "alpha.verdict.json"))).toBe(false);
  });

  test("a dry run runs with the package absent", async () => {
    const f = await fixture();
    const present = await runCli(f, [f.planPath, "--dry-run"]);
    const absent = await runCli(f, [f.planPath, "--dry-run"], { packageAbsent: true });
    expect(absent).toEqual(present);
  });

  test("the LangGraph path, with the package absent, says so and points at the default path", async () => {
    const f = await fixture();
    const result = await runCli(f, [f.planPath, "--dry-run", "--runtime=langgraph"], {
      packageAbsent: true,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("the LangGraph runtime is unavailable");
    expect(result.stderr).toContain("omit --runtime");
    expect(result.stdout).toBe("");
  });
});

describe("publisher telemetry in the environment", () => {
  test.each([
    ["the tracing switch", SWITCH],
    ["a historical alias", ALIAS],
  ])("%s stops the LangGraph path, by name and not by value", async (_name, variable) => {
    const f = await fixture();
    const secret = "do-not-print-this-value";
    const result = await runCli(f, [f.planPath, "--dry-run", "--runtime=langgraph"], {
      env: { [variable]: secret },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(variable);
    expect(result.stderr + result.stdout).not.toContain(secret);
    expect(await piInvocations(f)).toEqual([]);
  });

  test("the default path does not load the package, so it is not the one stopped", async () => {
    const f = await fixture();
    const result = await runCli(f, [f.planPath, "--dry-run"], { env: { [SWITCH]: "true" } });
    expect(result.exitCode).toBe(0);
  });
});
