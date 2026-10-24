import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePlan } from "./fanout-core";
import {
  ALL_CONDITIONS_MET_FOR_TESTS,
  disposeFixture,
  type Fixture,
  fixtureGit,
  makeFixture,
  setFakePiMode,
} from "./fanout-fixtures";
import { runCampaignGraph } from "./fanout-graph";
import {
  type CampaignInput,
  type CampaignIo,
  type CampaignOutcome,
  openCampaign,
  reportJournal,
  runCampaignDirect,
} from "./fanout-run";

// The two drivers, with the real effects (git worktrees, a stand-in `pi`, the
// journal, the verdict files) instead of scripted executors. The graph driver
// refuses real passes until its activation conditions hold (fanout-activation.ts);
// these tests hand it a table marked met, so its behaviour is pinned in the
// meantime and activating it changes a condition and nothing else.

// Each test runs two campaigns with real worktrees and a child process per pass.
setDefaultTimeout(30000);

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const created of fixtures.splice(0)) await disposeFixture(created);
});

interface Run {
  readonly outcome: CampaignOutcome;
  readonly lines: string[];
  readonly files: Record<string, unknown>;
  readonly journal: { role: string; type: string; detail?: Record<string, unknown> }[];
}

async function drive(
  fixture: Fixture,
  driver: (input: CampaignInput) => Promise<CampaignOutcome>,
  outputName: string,
  piMode: string,
): Promise<Run> {
  const outputDir = join(fixture.dir, "out", outputName);
  const plan = parsePlan({ ...(await Bun.file(fixture.planPath).json()), outputDir });
  const lines: string[] = [];
  const io: CampaignIo = {
    log: (line) => lines.push(`log: ${line}`),
    error: (line) => lines.push(`err: ${line}`),
  };
  let counter = 0;

  // The stand-in is named by path and told how to behave by a file beside it:
  // nothing in this process's environment changes.
  await setFakePiMode(fixture, piMode);
  const outcome = await driver({
    plan,
    force: false,
    dryRun: false,
    makeId: () => {
      counter += 1;
      return `rp-fixed-${counter}`;
    },
    hasRecordedVerdict: (job) => existsSync(job.outputPath),
    open: (campaignPlan) =>
      openCampaign(campaignPlan, { repoDir: fixture.dir, piBinary: fixture.piBinary }),
    verify: (journalPath, results) => reportJournal(journalPath, results, io),
    io,
  });
  return {
    outcome,
    lines: lines.map((line) => line.replaceAll(outputDir, "<out>")),
    files: await verdictsOf(outputDir),
    journal: await journalOf(outputDir),
  };
}

/** Verdict files, minus the fields that legitimately differ between two runs. */
async function verdictsOf(outputDir: string): Promise<Record<string, unknown>> {
  const files: Record<string, unknown> = {};
  if (!existsSync(outputDir)) return files;
  for (const name of readdirSync(outputDir).sort()) {
    if (!name.endsWith(".verdict.json")) continue;
    const record = await Bun.file(join(outputDir, name)).json();
    const { startedAt: _startedAt, durationMs: _durationMs, ...runner } = record.runner;
    files[name] = { ...record, runner };
  }
  return files;
}

async function journalOf(outputDir: string): Promise<Run["journal"]> {
  const path = join(outputDir, "events.jsonl");
  if (!existsSync(path)) return [];
  const events = (await Bun.file(path).text())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Run["journal"][number] & { reviewPassId: string });
  // Passes of a lot interleave in time; what is pinned is each pass's own sequence.
  return events
    .map(({ role, type, detail }) => {
      const { durationMs: _durationMs, outputPath: _outputPath, ...rest } = detail ?? {};
      return { role, type, detail: rest };
    })
    .sort((a, b) => a.role.localeCompare(b.role));
}

async function bothDrivers(roles: readonly string[], piMode: string) {
  const fixture = await makeFixture(roles);
  fixtures.push(fixture);
  const direct = await drive(fixture, runCampaignDirect, "direct", piMode);
  const graph = await drive(
    fixture,
    (input) => runCampaignGraph(input, ALL_CONDITIONS_MET_FOR_TESTS),
    "graph",
    piMode,
  );
  return { fixture, direct, graph };
}

function summary(outcome: CampaignOutcome) {
  return {
    run: outcome.run.map((job) => [job.reviewPassId, job.role]),
    failed: outcome.failed,
    results: outcome.results.map((result) => [result.job.role, result.ok, result.errors.length]),
  };
}

describe("real passes through the graph driver", () => {
  test("record the verdicts and the journal the default driver records", async () => {
    const { direct, graph } = await bothDrivers(["alpha", "beta", "gamma"], "approve");

    expect(summary(graph.outcome)).toEqual(summary(direct.outcome));
    expect(graph.outcome.failed).toBe(0);
    expect(Object.keys(graph.files)).toEqual([
      "alpha.verdict.json",
      "beta.verdict.json",
      "gamma.verdict.json",
    ]);
    expect(graph.files).toEqual(direct.files);
    expect(graph.journal).toEqual(direct.journal);
    expect(graph.lines).toEqual(direct.lines);
    expect(graph.lines.join("\n")).toContain("events across 3 pass(es)");
  });

  test("fail the same passes the same way when the reviewer fails", async () => {
    const { direct, graph } = await bothDrivers(["alpha", "beta"], "exit1");

    expect(graph.outcome.failed).toBe(2);
    expect(summary(graph.outcome)).toEqual(summary(direct.outcome));
    expect(graph.files).toEqual({});
    expect(graph.journal).toEqual(direct.journal);
    expect(graph.lines).toEqual(direct.lines);
  });

  test("invalidate the same passes when the reviewer writes to its tree", async () => {
    const { direct, graph } = await bothDrivers(["alpha"], "dirty");

    expect(graph.outcome.failed).toBe(1);
    expect(graph.journal.map((event) => event.type)).toContain("worktree_dirty");
    expect(graph.journal).toEqual(direct.journal);
    expect(graph.outcome.results[0]?.errors[0]).toContain("worktree dirty after review pass");
  });

  test("remove every scratch worktree, and leave the repository as it was", async () => {
    const { fixture } = await bothDrivers(["alpha", "beta"], "approve");

    const listing = await fixtureGit(fixture.dir, ["worktree", "list", "--porcelain"]);
    expect(listing.split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
    expect(await fixtureGit(fixture.dir, ["status", "--porcelain"])).toBe("");
  });
});
