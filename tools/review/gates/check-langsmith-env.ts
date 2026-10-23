// Entry gate for the LangGraph review fan-out — CA-21 (ADR-0058 section 3, condition 4, first
// mechanism; ADR-0032 D4).
//
// Adapted from the fleet template `distribution/templates/langgraph-gates/check-langsmith-env.ts`
// of libre-ai/project-governance. Self-contained on purpose: one file, `node:` and `Bun` only, so
// that a mutant of it can be run alone (see telemetry-variables.test.ts).
//
// Usage: bun check-langsmith-env.ts [--root=<dir>] [--exemptions=<path relative to the root>]
//
//   --root        the repository to examine (default: the current directory). It must be a git
//                 work tree: the universe is its TRACKED files, so an untracked file is not seen.
//   --exemptions  the data file that lists the paths the gate does not judge (default:
//                 DEFAULT_EXEMPTIONS below). It must be tracked: an exemption list the repository
//                 does not commit cannot be read as policy.
//
// What it refuses: a variable name that starts with the LangSmith prefix, and five historical
// aliases of the same switch, anywhere in a tracked text file — code, configuration, environment
// file, workflow, AND prose (the template skipped prose; CA-21 names no prose exemption, it names
// two files). An exempt file is still read: the names it holds are counted and printed, so that
// the exemption is a visible volume and not a blind spot.
//
// The file does not contain the names it refuses: they are assembled from parts, because the gate
// scans its own repository and would otherwise refuse itself. Its test builds its fixtures the
// same way.
//
// What it does NOT see, and prints on every run: a name built at run time (a concatenation, a
// template string, a computed key), an untracked file. The second mechanism of the condition —
// the egress refusal by the network policy (CA-22) — is the only control for those.

import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_EXEMPTIONS = "tools/review/gates/telemetry-exemptions.v1.json";

const PREFIX = `${"LANGSMITH"}${"_"}`;
const ALIAS_SUFFIXES = ["TRACING_V2", "TRACING", "API_KEY", "ENDPOINT", "CALLBACKS_BACKGROUND"];
const ALIASES = ALIAS_SUFFIXES.map((suffix) => `LANGCHAIN${"_"}${suffix}`);

// A name only counts when it is a whole name: `MY_<name>` does not start with the prefix, and an
// alias followed by more name characters is a different variable.
const REFUSED_NAME = new RegExp(
  `(?<![A-Za-z0-9_])(?:${PREFIX}[A-Za-z0-9_]*|${ALIASES.join("|")})(?![A-Za-z0-9_])`,
  "g",
);

export interface Finding {
  readonly line: number;
  readonly name: string;
}

/** The refused names of a text, with their line. The line itself is never kept: a `.env` line may carry a key. */
export function scanText(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(REFUSED_NAME)) {
      findings.push({ line: index + 1, name: match[0] });
    }
  }
  return findings;
}

export interface Exemption {
  readonly path: string;
  readonly reason: string;
}

export interface Exemptions {
  readonly exempt: readonly Exemption[];
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseExemptions(text: string): Exemptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { exempt: [], errors: [`does not parse as JSON: ${(error as Error).message}`] };
  }
  if (!isRecord(parsed)) return { exempt: [], errors: ["is not a JSON object"] };
  const errors: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (key !== "schema" && key !== "exempt") errors.push(`unknown key '${key}'`);
  }
  if (parsed.schema !== "telemetry-exemptions.v1") {
    errors.push("schema must be 'telemetry-exemptions.v1'");
  }
  if (!Array.isArray(parsed.exempt)) {
    errors.push("'exempt' must be an array");
    return { exempt: [], errors };
  }
  const exempt: Exemption[] = [];
  const seen = new Set<string>();
  for (const [index, item] of parsed.exempt.entries()) {
    const where = `exempt[${index}]`;
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.reason !== "string") {
      errors.push(`${where}: expected { path: string, reason: string }`);
      continue;
    }
    if (item.path === "" || item.path.startsWith("/") || item.path.split("/").includes("..")) {
      errors.push(`${where}: '${item.path}' is not a repository-relative path`);
    } else if (item.reason.trim() === "") {
      errors.push(`${where}: '${item.path}' has an empty reason`);
    } else if (seen.has(item.path)) {
      errors.push(`${where}: '${item.path}' is already exempt`);
    } else {
      seen.add(item.path);
      exempt.push({ path: item.path, reason: item.reason });
    }
  }
  return { exempt, errors };
}

export interface Arguments {
  readonly root: string;
  readonly exemptions: string;
}

export function parseArguments(argv: readonly string[]): Arguments {
  let root = ".";
  let exemptions = DEFAULT_EXEMPTIONS;
  for (const argument of argv) {
    if (argument.startsWith("--root=")) root = argument.slice("--root=".length);
    else if (argument.startsWith("--exemptions=")) {
      exemptions = argument.slice("--exemptions=".length);
    } else throw new Error(`unknown argument '${argument}'`);
  }
  return { root: resolve(root), exemptions };
}

function trackedFiles(root: string): string[] {
  const result = Bun.spawnSync(["git", "-C", root, "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    // Not "no files": the inventory itself could not be taken.
    throw new Error(
      `git ls-files failed in ${root}: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter((path) => path !== "");
}

export interface ExemptReading {
  readonly path: string;
  readonly names: number;
}

/** How the tracked tree was swept. The counters sum to `tracked`: each path lands in exactly one. */
export interface Sweep {
  readonly tracked: number;
  readonly scanned: number;
  readonly exempt: readonly ExemptReading[];
  readonly binary: number;
  readonly notRegular: readonly string[];
  readonly unreadable: readonly string[];
  readonly refused: readonly string[];
  readonly staleExemptions: readonly string[];
}

export function sweep(root: string, tracked: readonly string[], exempt: readonly string[]): Sweep {
  const exemptPaths = new Set(exempt);
  const notRegular: string[] = [];
  const unreadable: string[] = [];
  const refused: string[] = [];
  const exempted: ExemptReading[] = [];
  let scanned = 0;
  let binary = 0;
  for (const path of tracked) {
    const absolute = join(root, path);
    let regular: boolean;
    try {
      regular = lstatSync(absolute).isFile();
    } catch {
      unreadable.push(path);
      continue;
    }
    if (!regular) {
      // The repository versions the link, not its target: the target is swept if it is tracked.
      notRegular.push(path);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch {
      unreadable.push(path);
      continue;
    }
    const isBinary = bytes.includes(0);
    if (exemptPaths.has(path)) {
      exempted.push({ path, names: isBinary ? 0 : scanText(bytes.toString("utf8")).length });
      continue;
    }
    if (isBinary) {
      binary += 1;
      continue;
    }
    scanned += 1;
    for (const finding of scanText(bytes.toString("utf8"))) {
      refused.push(`${path}:${finding.line}: ${finding.name}`);
    }
  }
  const trackedSet = new Set(tracked);
  return {
    tracked: tracked.length,
    scanned,
    exempt: exempted,
    binary,
    notRegular,
    unreadable,
    refused,
    staleExemptions: exempt.filter((path) => !trackedSet.has(path)),
  };
}

export function verdict(result: Sweep): string[] {
  const failures: string[] = [];
  for (const refusal of result.refused) failures.push(`refused name ${refusal}`);
  for (const path of result.unreadable) failures.push(`${path}: tracked but unreadable`);
  for (const path of result.staleExemptions) {
    failures.push(`${path}: exempt by the data file but not a tracked file`);
  }
  if (result.scanned === 0) failures.push("scanned 0 file(s): the gate examined nothing");
  return failures;
}

if (import.meta.main) {
  let args: Arguments;
  let tracked: string[];
  try {
    args = parseArguments(Bun.argv.slice(2));
    tracked = trackedFiles(args.root);
  } catch (error) {
    console.error(`LangSmith env: ${(error as Error).message}`);
    process.exit(2);
  }
  const failures: string[] = [];

  let exemptions: Exemptions = { exempt: [], errors: [] };
  if (!tracked.includes(args.exemptions)) {
    failures.push(`${args.exemptions}: the exemption data is not a tracked file of ${args.root}`);
  } else {
    try {
      exemptions = parseExemptions(readFileSync(join(args.root, args.exemptions), "utf8"));
    } catch (error) {
      failures.push(`${args.exemptions}: exemption data unreadable (${(error as Error).message})`);
    }
  }
  for (const error of exemptions.errors) failures.push(`${args.exemptions}: ${error}`);

  const result = sweep(
    args.root,
    tracked,
    exemptions.exempt.map((item) => item.path),
  );
  const named = result.notRegular.length === 0 ? "" : `: ${result.notRegular.join(", ")}`;
  console.log(
    `LangSmith env: ${result.tracked} tracked file(s): ${result.scanned} scanned, ` +
      `${result.exempt.length} exempt by path, ${result.binary} binary, ` +
      `${result.notRegular.length} not regular${named}, ${result.unreadable.length} unreadable; ` +
      `${result.refused.length} refused name(s)`,
  );
  const exemptLine =
    result.exempt.length === 0
      ? "none"
      : result.exempt.map((item) => `${item.path} (${item.names} name(s) inside)`).join(", ");
  console.log(`LangSmith env: exempt from ${args.exemptions}: ${exemptLine}`);
  console.log(
    "LangSmith env: not seen — a name built at run time, an untracked file; " +
      "the egress refusal (CA-22) is the control for those",
  );
  failures.push(...verdict(result));
  if (failures.length > 0) {
    for (const failure of failures) console.error(`LangSmith env: ${failure}`);
    console.error(`LangSmith env failed: ${failures.length} problem(s).`);
    process.exit(1);
  }
  console.log("LangSmith env verified: no refused name in the scanned files.");
}
