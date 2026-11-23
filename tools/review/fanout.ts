import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  activationRefusal,
  assertNoPublisherTelemetry,
  LANGGRAPH_ACTIVATION_CONDITIONS,
} from "./fanout-activation";
import { parsePlan, resolveReviewProtocol } from "./fanout-core";
import { formatReviewScope, formatSealPreview, parseCoverageRequest } from "./fanout-coverage";
import {
  type CampaignInput,
  type CampaignOutcome,
  concludeCoverage,
  consoleIo,
  git,
  gitIn,
  openCampaign,
  prepareCoverage,
  printResults,
  reportJournal,
  runCampaignDirect,
} from "./fanout-run";

// Review fan-out orchestrator (docs/reviews/AGENT-REVIEW-PROTOCOL.md,
// "Orchestration mechanics"). Launches one pi review pass per role against an
// immutable commit, in parallel batches, with deduplication and a
// machine-readable verdict envelope per pass.
//
// Usage: bun tools/review/fanout.ts <plan.json> [--dry-run] [--force]
//                                   [--runtime=direct|langgraph]
//
// `direct` (the default) is the driver that needs no package. `langgraph`
// drives the same campaign through a LangGraph graph (fanout-graph.ts, loaded
// only when asked for): it answers `--dry-run`, and refuses real passes until
// its activation conditions hold (fanout-activation.ts). Either way the plan,
// the verdicts and the journal are the same.
//
// Coverage (fanout-coverage.ts): a plan with `"coverage": { "base": "<sha>" }`
// (and optionally `"rules": "<path>"`, read at the base) seals the reviewed
// file set of base..commit before any pass, hands it to every pass, and writes
// `coverage.manifest.json` beside the verdicts. The run exits 1 unless that
// manifest is complete. A plan without it is never declared complete.

const USAGE =
  "usage: bun tools/review/fanout.ts <plan.json> [--dry-run] [--force] [--runtime=direct|langgraph]";

type Runtime = "direct" | "langgraph";

function parseRuntime(args: readonly string[]): Runtime | null {
  const flags = args.filter((arg) => arg === "--runtime" || arg.startsWith("--runtime="));
  if (flags.length === 0) return "direct";
  const [flag] = flags;
  if (flags.length > 1 || flag === undefined) return null;
  const value = flag.slice("--runtime=".length);
  return flag.startsWith("--runtime=") && (value === "direct" || value === "langgraph")
    ? value
    : null;
}

async function loadGraphDriver(): Promise<(input: CampaignInput) => Promise<CampaignOutcome>> {
  try {
    assertNoPublisherTelemetry();
    const { runCampaignGraph } = await import("./fanout-graph");
    return runCampaignGraph;
  } catch (cause) {
    console.error(
      `the LangGraph runtime is unavailable: ${cause instanceof Error ? cause.message : String(cause)}\n` +
        "the default path needs no package: omit --runtime",
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const runtime = parseRuntime(args);
  const planPath = args.find((arg) => !arg.startsWith("--"));
  if (planPath === undefined || runtime === null) {
    console.error(USAGE);
    process.exit(2);
  }
  if (runtime === "langgraph" && !dryRun) {
    const refusal = activationRefusal(LANGGRAPH_ACTIVATION_CONDITIONS);
    if (refusal !== null) {
      console.error(refusal);
      process.exit(2);
    }
  }
  const protocol = resolveReviewProtocol(existsSync);
  if (!protocol.ok) {
    console.error(protocol.message);
    process.exit(2);
  }

  const rawPlan: unknown = await Bun.file(planPath).json();
  const plan = parsePlan(rawPlan);
  const coverageRequest = parseCoverageRequest(rawPlan);
  await git(["cat-file", "-e", `${plan.commit}^{commit}`]);

  // The scope is sealed before any pass runs, and handed to every pass.
  const coverage =
    coverageRequest === null ? null : await prepareCoverage(plan, coverageRequest, gitIn("."));
  if (coverage !== null) {
    for (const line of formatSealPreview(coverage.sealed, coverage.rules, dryRun)) {
      consoleIo.log(line);
    }
  }
  const reviewScope =
    coverage === null ? undefined : formatReviewScope(coverage.sealed, coverage.rules);

  const drive = runtime === "langgraph" ? await loadGraphDriver() : runCampaignDirect;
  const outcome = await drive({
    plan,
    force,
    dryRun,
    makeId: () => `rp-${plan.commit.slice(0, 7)}-${randomUUID()}`,
    hasRecordedVerdict: (job) => existsSync(job.outputPath),
    open: (campaignPlan) =>
      openCampaign(campaignPlan, reviewScope === undefined ? {} : { reviewScope }),
    verify: (journalPath, results) => reportJournal(journalPath, results, consoleIo),
    io: consoleIo,
  });

  if (outcome.collisions.length > 0) process.exit(2);
  const failed = printResults(outcome.results, consoleIo);
  if (dryRun) process.exit(failed > 0 ? 1 : 0);

  // Passes that succeeded do not make a complete review: only a complete
  // coverage manifest does, and a plan without `coverage.base` has none.
  if (coverage === null) {
    consoleIo.error(
      "coverage: no manifest — the plan declares no coverage.base, so this review is not declared complete",
    );
  } else {
    const closed = await concludeCoverage(coverage, outcome, plan.outputDir, consoleIo);
    if (closed.status !== "complete") process.exit(1);
  }
  if (failed > 0) process.exit(1);
}

await main();
