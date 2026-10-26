import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

// Conditions under which the LangGraph runtime may run REAL review passes.
//
// Admitting the runtime (ADR-0058 section 1) lifts no activation condition: an
// orchestrator that puts a model in front of untrusted content while it holds
// tools with effects is activated only once it holds INV-a, INV-b and INV-c and
// their red vectors pass (ADR-0045 decision 4), and ADR-0058 section 3
// condition 4 adds the egress vector: "a harness that does not produce this
// refusal does not activate the worker". Work package WP-2 ships the runtime;
// WP-3 ships the proofs of INV-a to INV-c (tools/review/vectors), WP-4 the
// egress and adaptive-attack proofs. Until every condition holds, the LangGraph
// path answers `--dry-run` and refuses everything else.
//
// The table is code, not configuration: nothing in the environment or on the
// command line can mark a condition met. A condition flips to `satisfied: true`
// in the pull request that adds its vector, and names that vector in `evidence`.
// The graph driver applies the table itself (fanout-graph.ts), so a script that
// imports the driver meets the same refusal as the command line.

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

// A proof is a test file of the vectors directory, named by its plain
// repository-relative path: not a directory, not any file that happens to
// exist (package.json), not a test elsewhere in the tree.
const PROOF_PATH_PATTERN = /^tools\/review\/vectors\/[A-Za-z0-9][A-Za-z0-9._-]*\.test\.ts$/;

/**
 * True when `path` names a regular test file under tools/review/vectors/ of
 * the repository: neither a link (a link inside the root to a file elsewhere
 * is not a proof) nor a directory, and the path resolves to itself.
 * @internal `root` is a parameter for the tests only.
 */
export function isProofInRepository(path: string, root: string = REPO_ROOT): boolean {
  if (!PROOF_PATH_PATTERN.test(path)) return false;
  const resolved = resolve(root, path);
  const entry = lstatSync(resolved, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isFile()) return false;
  return realpathSync(resolved) === join(realpathSync(root), path);
}

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

/**
 * The table, and each condition in it, frozen: no code that imports the
 * module can mark a condition met or swap a proof at run time; changing the
 * table is a change of this file, visible in review.
 */
function frozenTable(table: ActivationCondition[]): readonly ActivationCondition[] {
  for (const condition of table) Object.freeze(condition);
  return Object.freeze(table);
}

export const LANGGRAPH_ACTIVATION_CONDITIONS: readonly ActivationCondition[] = frozenTable([
  {
    id: "inv-a",
    requirement:
      "no untrusted string in front of a model that holds a write, execute or network tool",
    source: "ADR-0045 decision 1 (INV-a), CA-26",
    workPackage: "WP-3",
    satisfied: true,
    evidence: "tools/review/vectors/inv-a-read-only-passes.test.ts",
  },
  {
    id: "inv-b",
    requirement: "provenance by value, policy on every effect argument",
    source: "ADR-0045 decision 1 (INV-b), CA-27",
    workPackage: "WP-3",
    satisfied: true,
    evidence: "tools/review/vectors/inv-b-effect-arguments.test.ts",
  },
  {
    id: "inv-c",
    requirement: "quarantine output with a closed vocabulary",
    source: "ADR-0045 decision 1 (INV-c), CA-28",
    workPackage: "WP-3",
    satisfied: true,
    evidence: "tools/review/vectors/inv-c-closed-vocabulary.test.ts",
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
]);

/**
 * A condition counts as met only when it says so AND names a proof that exists
 * in the repository: a wrong path in the pull request that flips it must not
 * lift the refusal.
 */
export function unmetConditions(
  conditions: readonly ActivationCondition[] = LANGGRAPH_ACTIVATION_CONDITIONS,
): ActivationCondition[] {
  return conditions.filter(
    (condition) =>
      !(
        condition.satisfied &&
        condition.evidence !== null &&
        isProofInRepository(condition.evidence)
      ),
  );
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
