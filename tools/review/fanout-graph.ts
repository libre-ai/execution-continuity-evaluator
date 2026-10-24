import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import {
  type ActivationCondition,
  activationRefusal,
  assertNoPublisherTelemetry,
  LANGGRAPH_ACTIVATION_CONDITIONS,
} from "./fanout-activation";
import type { ReviewJob } from "./fanout-core";
import {
  announceCampaign,
  type CampaignInput,
  type CampaignOutcome,
  type JobResult,
  outcomeOf,
  type PassExecutor,
  planCampaign,
  shouldExecute,
} from "./fanout-run";

// The review fan-out as a LangGraph graph: roles → lots → verification →
// aggregation, with each `pi` pass a tool node. It is a second driver over the
// pieces `fanout-run.ts` already owns, not a second implementation of them.
//
// LangGraph is a structuring tool here and never an authority (ADR-0032 D2 to
// D5, ADR-0058 section 2, ADR-0037 D6):
//
//   * Routing is fixed by the orchestrator. The two routers below read the
//     plan-derived lot list, a cursor and the dry-run flag; they take no pass
//     result as input, so the output of `pi` cannot choose a transition. No
//     node names its own successor and none suspends for outside input.
//   * The graph is opaque. `runCampaignGraph` returns a `CampaignOutcome`, the
//     same closed shape the default driver returns; no node, edge or state
//     channel reaches an input, an output, a journal event or a verdict.
//   * Nothing persists. The graph is compiled with no persistence layer, so
//     there is no serializer to feed and nothing to resume from: a campaign
//     that dies is re-run, as it always was. The envelope key, which must never
//     be serialized, lives in the executor's closure, not in graph state.
//   * Telemetry is refused before the graph is built (`assertNoPublisherTelemetry`).
//   * Real passes are refused while an activation condition is unmet
//     (fanout-activation.ts). The refusal lives here, where the passes run, and
//     not only in the command line that selects this driver.

const CampaignState = Annotation.Root({
  run: Annotation<ReviewJob[]>({ reducer: (_, next) => next, default: () => [] }),
  skipped: Annotation<ReviewJob[]>({ reducer: (_, next) => next, default: () => [] }),
  collisions: Annotation<ReviewJob[]>({ reducer: (_, next) => next, default: () => [] }),
  batches: Annotation<ReviewJob[][]>({ reducer: (_, next) => next, default: () => [] }),
  cursor: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  // What the graph knows of a finished pass: closed fields only. The full
  // result, which carries text written by `pi` and by git (stderr, paths of a
  // dirty tree), stays in the session and never becomes a graph value.
  settled: Annotation<SettledPass[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  failed: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
});

interface SettledPass {
  readonly reviewPassId: string;
  readonly ok: boolean;
}

type CampaignStateValue = typeof CampaignState.State;

/** Split the passes to run into lots of at most `size`, in plan order. */
export function partitionLots(jobs: readonly ReviewJob[], size: number): ReviewJob[][] {
  const lots: ReviewJob[][] = [];
  for (let start = 0; start < jobs.length; start += size) {
    lots.push(jobs.slice(start, start + size));
  }
  return lots;
}

/** @internal Exported for the tests that pin the routing; reads plan-derived state only. */
export function routeAfterLots(state: {
  readonly dryRun: boolean;
  readonly collisions: readonly unknown[];
  readonly run: readonly unknown[];
}): "open" | "aggregation" {
  return shouldExecute(
    { run: state.run as ReviewJob[], collisions: state.collisions as ReviewJob[] },
    state.dryRun,
  )
    ? "open"
    : "aggregation";
}

/** @internal Exported for the tests that pin the routing; reads the cursor and the lot list only. */
export function routeAfterLot(state: {
  readonly lots: readonly unknown[];
  readonly cursor: number;
}): "pass" | "verification" {
  return state.cursor < state.lots.length ? "pass" : "verification";
}

interface Session {
  executor: PassExecutor | null;
  /** Full results, by pass id: held here so no pass output is a graph value. */
  readonly results: Map<string, JobResult>;
}

function newSession(): Session {
  return { executor: null, results: new Map() };
}

function resultsInPlanOrder(run: readonly ReviewJob[], session: Session): JobResult[] {
  return run.flatMap((job) => {
    const result = session.results.get(job.reviewPassId);
    return result === undefined ? [] : [result];
  });
}

/** Throws, before anything opens, when real passes are asked for and a condition is unmet. */
function refuseUnactivatedPasses(
  input: CampaignInput,
  conditions: readonly ActivationCondition[],
): void {
  if (input.dryRun) return;
  const refusal = activationRefusal(conditions);
  if (refusal !== null) throw new Error(refusal);
}

/** @internal Exposed so a test can inspect the compiled graph; use `runCampaignGraph`. */
export function buildCampaignGraph(
  input: CampaignInput,
  conditions: readonly ActivationCondition[] = LANGGRAPH_ACTIVATION_CONDITIONS,
  session: Session = newSession(),
) {
  refuseUnactivatedPasses(input, conditions);
  const graph = new StateGraph(CampaignState)
    .addNode("roles", () => {
      const planned = planCampaign(input);
      return { run: planned.run, skipped: planned.skipped, collisions: planned.collisions };
    })
    .addNode("lots", (state) => {
      announceCampaign(
        { run: state.run, skipped: state.skipped, collisions: state.collisions },
        input,
      );
      return { batches: partitionLots(state.run, input.plan.concurrency), cursor: 0 };
    })
    .addNode("open", async () => {
      session.executor = await input.open(input.plan);
      return {};
    })
    // The tool node: one `pi` pass in a detached worktree, validated and
    // recorded by the orchestrator. It receives its job from the fan-out, not
    // from graph state.
    .addNode("pass", async (payload: { job: ReviewJob }) => {
      const executor = session.executor;
      if (executor === null) throw new Error("pass node reached before the executor was opened");
      const result = await executor.runPass(payload.job);
      session.results.set(payload.job.reviewPassId, result);
      return { settled: [{ reviewPassId: payload.job.reviewPassId, ok: result.ok }] };
    })
    .addNode("advance", (state) => ({ cursor: state.cursor + 1 }))
    .addNode("verification", async (state) => {
      const executor = session.executor;
      if (executor === null) throw new Error("verification reached before the executor was opened");
      await input.verify(executor.journalPath, resultsInPlanOrder(state.run, session));
      return {};
    })
    // Closed fields only: the aggregate reads `ok`, never the error text.
    .addNode("aggregation", (state) => ({
      failed: state.settled.filter((pass) => !pass.ok).length,
    }))
    .addEdge(START, "roles")
    .addEdge("roles", "lots")
    .addConditionalEdges("lots", (state) => routeAfterLots({ ...state, dryRun: input.dryRun }))
    .addConditionalEdges("open", (state) => fanOut(state))
    .addEdge("pass", "advance")
    .addConditionalEdges("advance", (state) => fanOut(state))
    .addEdge("verification", "aggregation")
    .addEdge("aggregation", END);

  return graph.compile();
}

function fanOut(state: Pick<CampaignStateValue, "batches" | "cursor">): Send[] | "verification" {
  if (routeAfterLot({ lots: state.batches, cursor: state.cursor }) === "verification") {
    return "verification";
  }
  const lot = state.batches[state.cursor] ?? [];
  return lot.map((job) => new Send("pass", { job }));
}

/**
 * The LangGraph driver. Same contract as `runCampaignDirect`, plus the
 * activation table: real passes are refused until every condition holds.
 * `conditions` is for the tests that pin real behaviour; production callers
 * leave it to the table in fanout-activation.ts.
 */
export async function runCampaignGraph(
  input: CampaignInput,
  conditions: readonly ActivationCondition[] = LANGGRAPH_ACTIVATION_CONDITIONS,
): Promise<CampaignOutcome> {
  assertNoPublisherTelemetry();
  refuseUnactivatedPasses(input, conditions);
  const session = newSession();
  try {
    const graph = buildCampaignGraph(input, conditions, session);
    const finalState = await graph.invoke(
      {},
      {
        maxConcurrency: input.plan.concurrency,
        // Two supersteps per lot plus the fixed stages; the default limit of 25
        // would reject a plan with many roles and a low concurrency.
        recursionLimit: 12 + 2 * input.plan.roles.length,
      },
    );
    const planned = {
      run: finalState.run,
      skipped: finalState.skipped,
      collisions: finalState.collisions,
    };
    const results = shouldExecute(planned, input.dryRun)
      ? resultsInPlanOrder(finalState.run, session)
      : [];
    return { ...outcomeOf(planned, results), failed: finalState.failed };
  } finally {
    await session.executor?.dispose();
  }
}
