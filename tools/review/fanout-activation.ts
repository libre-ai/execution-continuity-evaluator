// Conditions under which the LangGraph runtime may run REAL review passes.
//
// Admitting the runtime (ADR-0058 section 1) lifts no activation condition: an
// orchestrator that puts a model in front of untrusted content while it holds
// tools with effects is activated only once it holds INV-a, INV-b and INV-c and
// their red vectors pass (ADR-0045 decision 4), and ADR-0058 section 3
// condition 4 adds the egress vector: "a harness that does not produce this
// refusal does not activate the worker". Work package WP-2 ships the runtime;
// WP-3 and WP-4 ship the proofs. Until they do, the LangGraph path answers
// `--dry-run` and refuses everything else.
//
// The table is code, not configuration: nothing in the environment or on the
// command line can mark a condition met. A condition flips to `satisfied: true`
// in the pull request that adds its vector, and names that vector in `evidence`.

export interface ActivationCondition {
  readonly id: string;
  readonly requirement: string;
  readonly source: string;
  /** Work package of the PRD (docs/prd.md section 9) that delivers the proof. */
  readonly workPackage: string;
  readonly satisfied: boolean;
  /** Repository-relative path of the test that proves the condition; null while unmet. */
  readonly evidence: string | null;
}

export const LANGGRAPH_ACTIVATION_CONDITIONS: readonly ActivationCondition[] = [
  {
    id: "inv-a",
    requirement:
      "no untrusted string in front of a model that holds a write, execute or network tool",
    source: "ADR-0045 decision 1 (INV-a), CA-26",
    workPackage: "WP-3",
    satisfied: false,
    evidence: null,
  },
  {
    id: "inv-b",
    requirement: "provenance by value, policy on every effect argument",
    source: "ADR-0045 decision 1 (INV-b), CA-27",
    workPackage: "WP-3",
    satisfied: false,
    evidence: null,
  },
  {
    id: "inv-c",
    requirement: "quarantine output with a closed vocabulary",
    source: "ADR-0045 decision 1 (INV-c), CA-28",
    workPackage: "WP-3",
    satisfied: false,
    evidence: null,
  },
  {
    id: "telemetry-egress-refused",
    requirement: "an attempt to reach a publisher telemetry host is refused and counted",
    source: "ADR-0058 section 3 condition 4, CA-22",
    workPackage: "WP-4",
    satisfied: false,
    evidence: null,
  },
  {
    id: "adaptive-attacks",
    requirement: "adaptive attack suite, utility and attack success rates reported together",
    source: "ADR-0045 consequences (vector 4), CA-31",
    workPackage: "WP-4",
    satisfied: false,
    evidence: null,
  },
];

/** A condition counts as met only when it says so AND names the proof. */
export function unmetConditions(
  conditions: readonly ActivationCondition[] = LANGGRAPH_ACTIVATION_CONDITIONS,
): ActivationCondition[] {
  return conditions.filter((condition) => !(condition.satisfied && condition.evidence !== null));
}

/** The refusal message for real passes on the LangGraph path, or null when activated. */
export function activationRefusal(
  conditions: readonly ActivationCondition[] = LANGGRAPH_ACTIVATION_CONDITIONS,
): string | null {
  const unmet = unmetConditions(conditions);
  if (unmet.length === 0) return null;
  return [
    `the LangGraph runtime does not run real review passes yet: ${unmet.length} of ${conditions.length} activation condition(s) unmet`,
    ...unmet.map(
      (condition) =>
        `- ${condition.id}: ${condition.requirement} (${condition.source}; delivered by ${condition.workPackage})`,
    ),
    "--dry-run is available on this runtime; omit --runtime to run the default path",
  ].join("\n");
}

// The runtime complement of the textual telemetry gate (CA-21). That gate
// refuses to WRITE a switch into the repository; it cannot see the environment
// of the machine the orchestrator runs on. The package reads these variables
// itself, and a tracing switch exported in a shell would send graph inputs and
// outputs (plan, paths, pass errors) to the publisher's hosted service. The
// guard names a variable, never its value. The names are assembled from parts,
// as the gate does, so the guard does not trip the gate it complements.
const SWITCH_PREFIX = `${"LANGSMITH"}${"_"}`;
const ALIAS_SUFFIXES = ["TRACING_V2", "TRACING", "API_KEY", "ENDPOINT", "CALLBACKS_BACKGROUND"];
const ALIASES = new Set(ALIAS_SUFFIXES.map((suffix) => `LANGCHAIN${"_"}${suffix}`));

/** Names of the publisher telemetry variables set in `env`, sorted; values are never read. */
export function publisherTelemetryVariables(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith(SWITCH_PREFIX) || ALIASES.has(name))
    .sort();
}

/** Throws when the environment carries a publisher telemetry switch. */
export function assertNoPublisherTelemetry(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const names = publisherTelemetryVariables(env);
  if (names.length > 0) {
    throw new Error(
      `refusing to run the LangGraph runtime with publisher telemetry variables set (${names.join(", ")}): ` +
        "unset them (ADR-0058 section 3 condition 4, ENF-8)",
    );
  }
}
