import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  ActivationRefusedError,
  activationRefusal,
  assertNoPublisherTelemetry,
  LANGGRAPH_ACTIVATION_CONDITIONS,
} from "./fanout-activation";
import { neutralizeControls, parsePlan, resolveReviewProtocol } from "./fanout-core";
import {
  type CampaignInput,
  type CampaignOutcome,
  consoleIo,
  git,
  openCampaign,
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
// its activation conditions hold (fanout-activation.ts). The default driver
// refuses real passes too until a pass is confined to its worktree (CA-32):
// both refusals exit 2. Either way the plan, the verdicts and the journal are
// the same.

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
    // The cause may quote paths and environment variable names.
    const reason = neutralizeControls(cause instanceof Error ? cause.message : String(cause));
    console.error(
      `the LangGraph runtime is unavailable: ${reason}\n` +
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

  const plan = parsePlan(await Bun.file(planPath).json());
  await git(["cat-file", "-e", `${plan.commit}^{commit}`]);

  const drive =
    runtime === "langgraph"
      ? await loadGraphDriver()
      : (input: CampaignInput) => runCampaignDirect(input);
  let outcome: CampaignOutcome;
  try {
    outcome = await drive({
      plan,
      force,
      dryRun,
      makeId: () => `rp-${plan.commit.slice(0, 7)}-${randomUUID()}`,
      hasRecordedVerdict: (job) => existsSync(job.outputPath),
      open: (campaignPlan) => openCampaign(campaignPlan),
      verify: (journalPath, results) => reportJournal(journalPath, results, consoleIo),
      io: consoleIo,
    });
  } catch (cause) {
    // A driver that refuses real passes (activation table) says why; nothing ran.
    if (cause instanceof ActivationRefusedError) {
      console.error(cause.message);
      process.exit(2);
    }
    throw cause;
  }

  if (outcome.collisions.length > 0) process.exit(2);
  if (printResults(outcome.results, consoleIo) > 0) process.exit(1);
}

await main();
