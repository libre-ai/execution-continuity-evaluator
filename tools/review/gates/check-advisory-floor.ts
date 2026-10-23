// Entry gate for the LangGraph review fan-out — CA-18, second instrument (ADR-0058 section 3,
// condition 1): the versioned advisory floor `tools/review/advisories.v1.json` against the
// resolved lockfile. The first instrument, `osv-scanner` offline, is check-osv-advisories.ts.
//
// Adapted from the fleet template `distribution/templates/langgraph-gates/check-langgraph-advisory-floor.ts`
// of libre-ai/project-governance. Self-contained on purpose: one file, `node:` and `Bun` only,
// plus publisher-scope.ts (itself `node:` only) for the sweep the two advisory gates share, so
// that a mutant of it can be run alone with that module (see advisory-floor.test.ts).
//
// Usage: bun check-advisory-floor.ts [--root=<dir>] [--floor=<path>] [--lock=<path>] [--manifest=<path>]
//
//   --root      the repository to examine (default: the current directory). It must be a git work
//               tree: the floor, the lockfile and the manifest are TRACKED files, so a floor the
//               repository does not commit cannot be read as policy.
//   --floor     the data file (default: DEFAULT_FLOOR). Tracked.
//   --lock      the resolved graph (default: DEFAULT_LOCK). Tracked, and a `bun.lock`: the
//               template also read npm lockfiles, this repository has one lockfile format and a
//               reader that is never exercised is a reader that can be wrong.
//   --manifest  the manifest of the graph (default: DEFAULT_MANIFEST). Tracked.
//
// The floor is data (schema `advisories.v1`), one entry per (package, minimum version, advisory
// id): CA-18's triple, plus the publisher repository whose security-advisories list names the id,
// so that every row has a replayable source. Adding an entry is a reviewed edit. The file also
// carries `denied`: an exact version that a floor cannot express (an advisory with no fixed
// version — the 2.0.0 line of the sdk package in GHSA-432w-3h3v-2pv4 passes every minimum).
//
// Rule: every resolved version of a floor package is greater than or equal to its minimum, under
// semver ordering (a pre-release of the minimum is below it); a resolved version equal to a denied
// one fails. Two entries for one package are two assertions: the higher minimum decides.
//
// A floor the file cannot lower: REQUIRED below is the list of CA-18 at 2026-10-23, kept in this
// gate and not in the data file. Removing a required entry from the data file — or lowering its
// minimum — must turn the gate red, and a check that reads only the file it checks cannot see its
// own deletion. The data file may carry more; a new advisory is an added entry, not a code edit.
//
// What a lockfile without the package means. The graph of tools/review has no LangGraph package
// until WP-2: then "every resolved version is at or above the floor" holds with nothing resolved.
// The gate says so on every run ("vacuous") instead of failing a repository that has nothing to
// compare, and stops being vacuous by itself the day the manifest declares a package of the
// family: a declared package that the lock does not resolve is a failure, so the lock cannot
// silently drift away from the manifest.
//
// Where the graph may live. ADR-0058 section 3, condition 1 binds EVERY resolved version of the
// graph, and docs/prd.md section 9 places it in the Bun workspace of tools/review: the manifest and
// the lockfile above. A package of the family declared in any other tracked package.json, or
// resolved in any other tracked lockfile, is a graph this comparison would never see — it is a
// failure naming the file and the package, never "vacuous" (publisher-scope.ts: the sweep, shared
// with check-osv-advisories.ts). The counters print the manifests and lockfiles examined and sum to
// the tracked files.
//
// Fail closed on what cannot be read: a data file that does not parse or breaks its schema, a
// lockfile that is not a `bun.lock`, does not parse, or lists no package, a manifest that does not
// parse, an entry with no name@version, and a floor package resolved at something that is not a
// semver number (`github:`, `file:`, `workspace:`).

import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  FAMILY,
  SCOPE_NOT_SEEN,
  scopeFailures,
  scopeVolume,
  sweepOutsideGraph,
} from "./publisher-scope";

const DEFAULT_FLOOR = "tools/review/advisories.v1.json";
const DEFAULT_LOCK = "tools/review/bun.lock";
const DEFAULT_MANIFEST = "tools/review/package.json";

const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const SEMVER_TRIPLE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const FILE_KEYS = ["schema", "readOn", "entries", "denied"];
const ADVISORY_ID = /^GHSA(?:-[2-9cfghjmpqrvwx]{4}){3}$/;
const SOURCE_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const READ_ON = /^\d{4}-\d{2}-\d{2}$/;
const RESOLVED_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface RequiredEntry {
  readonly package: string;
  readonly minimum: string;
  readonly advisory: string;
}

// CA-18, read on 2026-10-23, replayed on the publisher advisories the same day. One divergence
// from the text of CA-18, kept visible: it gives the sdk package `>= 1.12.3` for both of its
// advisories; the publisher gives 1.12.2 for GHSA-r3xm-q2gp-xjjg and 1.12.3 for GHSA-432w-3h3v-2pv4.
// The pair is required under the publisher's number; the effective minimum is 1.12.3 either way.
export const REQUIRED: readonly RequiredEntry[] = [
  { package: "@langchain/langgraph", minimum: "1.4.21", advisory: "GHSA-wp87-994x-j95x" },
  { package: "@langchain/langgraph", minimum: "1.4.12", advisory: "GHSA-j87f-x5h5-gr75" },
  { package: "@langchain/langgraph-checkpoint", minimum: "1.1.4", advisory: "GHSA-j87f-x5h5-gr75" },
  { package: "@langchain/core", minimum: "1.1.8", advisory: "GHSA-r399-636x-v7f6" },
  { package: "@langchain/langgraph-sdk", minimum: "1.12.3", advisory: "GHSA-432w-3h3v-2pv4" },
  { package: "@langchain/langgraph-sdk", minimum: "1.12.2", advisory: "GHSA-r3xm-q2gp-xjjg" },
];

export interface FloorEntry {
  readonly package: string;
  readonly minimum: string;
  readonly advisory: string;
  readonly source: string;
}

export interface DeniedVersion {
  readonly package: string;
  readonly version: string;
  readonly advisory: string;
  readonly source: string;
}

export interface Floor {
  readonly readOn: string;
  readonly entries: readonly FloorEntry[];
  readonly denied: readonly DeniedVersion[];
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first defect of one data row (`versionKey` is `minimum` for an entry, `version` for a denied one). */
function rowDefect(item: unknown, where: string, versionKey: "minimum" | "version"): string | null {
  if (!isRecord(item)) return `${where}: expected an object`;
  const allowed = ["package", versionKey, "advisory", "source"];
  const unexpected = Object.keys(item).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) return `${where}: unknown key '${unexpected}'`;
  const { package: name, advisory, source } = item;
  const version = item[versionKey];
  if (typeof name !== "string" || !PACKAGE_NAME.test(name))
    return `${where}: package '${String(name)}' is not a package name`;
  if (typeof version !== "string" || !SEMVER_TRIPLE.test(version))
    return `${where}: ${versionKey} '${String(version)}' is not an x.y.z version`;
  if (typeof advisory !== "string" || !ADVISORY_ID.test(advisory))
    return `${where}: advisory '${String(advisory)}' is not a GHSA identifier`;
  if (typeof source !== "string" || !SOURCE_REPOSITORY.test(source))
    return `${where}: source '${String(source)}' is not an owner/repository`;
  return null;
}

export function parseFloor(text: string): Floor {
  const none = { readOn: "", entries: [], denied: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ...none, errors: [`does not parse as JSON: ${(error as Error).message}`] };
  }
  if (!isRecord(parsed)) return { ...none, errors: ["is not a JSON object"] };
  const errors: string[] = [];
  const unexpected = Object.keys(parsed).find((key) => !FILE_KEYS.includes(key));
  if (unexpected !== undefined) errors.push(`file: unknown key '${unexpected}'`);
  if (parsed.schema !== "advisories.v1") errors.push("schema must be 'advisories.v1'");
  const readOn =
    typeof parsed.readOn === "string" && READ_ON.test(parsed.readOn) ? parsed.readOn : "";
  if (readOn === "") errors.push("readOn must be a YYYY-MM-DD date");
  if (!Array.isArray(parsed.entries)) errors.push("'entries' must be an array");
  if (!Array.isArray(parsed.denied)) errors.push("'denied' must be an array");

  const entries: FloorEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (Array.isArray(parsed.entries) ? parsed.entries : []).entries()) {
    const defect = rowDefect(item, `entries[${index}]`, "minimum");
    if (defect !== null) {
      errors.push(defect);
      continue;
    }
    const entry = item as FloorEntry;
    if (seen.has(`${entry.package} ${entry.advisory}`)) {
      errors.push(`entries[${index}]: ${entry.package} ${entry.advisory} is already an entry`);
      continue;
    }
    seen.add(`${entry.package} ${entry.advisory}`);
    entries.push(entry);
  }

  const denied: DeniedVersion[] = [];
  for (const [index, item] of (Array.isArray(parsed.denied) ? parsed.denied : []).entries()) {
    const defect = rowDefect(item, `denied[${index}]`, "version");
    if (defect !== null) errors.push(defect);
    else denied.push(item as DeniedVersion);
  }
  return { readOn, entries, denied, errors };
}

/** CA-18's list, entry by entry: present in the data file, at a minimum no lower than required. */
export function missingRequired(entries: readonly FloorEntry[]): string[] {
  const missing: string[] = [];
  for (const required of REQUIRED) {
    const entry = entries.find(
      (candidate) =>
        candidate.package === required.package && candidate.advisory === required.advisory,
    );
    if (entry === undefined) {
      missing.push(
        `required entry ${required.package} ${required.minimum} ${required.advisory} is absent`,
      );
    } else if (Bun.semver.order(entry.minimum, required.minimum) < 0) {
      missing.push(
        `required entry ${required.package} ${required.advisory} has minimum ${entry.minimum}, below the required ${required.minimum}`,
      );
    }
  }
  return missing;
}

export interface LockEntry {
  readonly name: string;
  readonly version: string;
  readonly where: string;
}

export type LockReading = { readonly entries: readonly LockEntry[] } | { readonly error: string };

export function readLockfile(path: string, text: string): LockReading {
  const name = basename(path);
  if (name !== "bun.lock") return { error: `format '${name}' is not read by this gate` };
  let parsed: unknown;
  try {
    parsed = Bun.JSONC.parse(text);
  } catch (error) {
    return { error: `does not parse as JSONC: ${(error as Error).message}` };
  }
  // A lockfile that lists no package is not evidence about the graph: it is a lockfile not read.
  const packages = isRecord(parsed) && isRecord(parsed.packages) ? parsed.packages : {};
  if (Object.keys(packages).length === 0) return { error: "has no packages table" };
  const entries: LockEntry[] = [];
  for (const [where, value] of Object.entries(packages)) {
    // [0] is `<real name>@<version>`: for an alias the key is the install name, [0] is the package.
    const spec = Array.isArray(value) ? value[0] : undefined;
    const at = typeof spec === "string" ? spec.lastIndexOf("@") : -1;
    if (typeof spec !== "string" || at <= 0)
      return { error: `entry '${where}' has no name@version` };
    entries.push({ name: spec.slice(0, at), version: spec.slice(at + 1), where });
  }
  return { entries };
}

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
];

/** Package names a manifest declares, by key and by `npm:` alias target. */
export function declaredNames(text: string): { names: string[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `does not parse as JSON: ${(error as Error).message}` };
  }
  if (!isRecord(parsed)) return { error: "is not a JSON object" };
  const names = new Set<string>();
  for (const section of DEPENDENCY_SECTIONS) {
    const table = parsed[section];
    if (!isRecord(table)) continue;
    for (const [key, value] of Object.entries(table)) {
      names.add(key);
      const alias = typeof value === "string" ? value.match(/^npm:(@?[^@]+)@/) : null;
      if (alias?.[1] !== undefined) names.add(alias[1]);
    }
  }
  return { names: [...names] };
}

export interface Evaluation {
  readonly defects: readonly string[];
  readonly resolvedRows: number;
  readonly absentRows: number;
  readonly entriesCompared: number;
}

export function evaluate(
  entries: readonly FloorEntry[],
  denied: readonly DeniedVersion[],
  lock: readonly LockEntry[],
  lockFile: string,
): Evaluation {
  const defects: string[] = [];
  let resolvedRows = 0;
  let absentRows = 0;
  let entriesCompared = 0;
  for (const row of entries) {
    let resolved = 0;
    for (const entry of lock) {
      if (entry.name !== row.package) continue;
      resolved += 1;
      entriesCompared += 1;
      if (!RESOLVED_VERSION.test(entry.version)) {
        defects.push(
          `${lockFile}: ${entry.name}@${entry.version} (${entry.where}) is not a version this gate can compare to ${row.minimum} (${row.advisory})`,
        );
      } else if (Bun.semver.order(entry.version, row.minimum) < 0) {
        defects.push(
          `${lockFile}: ${entry.name}@${entry.version} (${entry.where}) is below ${row.minimum} (${row.advisory})`,
        );
      }
    }
    if (resolved === 0) absentRows += 1;
    else resolvedRows += 1;
  }
  for (const ban of denied) {
    for (const entry of lock) {
      if (entry.name === ban.package && entry.version === ban.version) {
        defects.push(
          `${lockFile}: ${entry.name}@${entry.version} (${entry.where}) is a denied version, vulnerable with no fixed version (${ban.advisory})`,
        );
      }
    }
  }
  return { defects, resolvedRows, absentRows, entriesCompared };
}

export interface Arguments {
  readonly root: string;
  readonly floor: string;
  readonly lock: string;
  readonly manifest: string;
}

export function parseArguments(argv: readonly string[]): Arguments {
  let root = ".";
  let floor = DEFAULT_FLOOR;
  let lock = DEFAULT_LOCK;
  let manifest = DEFAULT_MANIFEST;
  for (const argument of argv) {
    if (argument.startsWith("--root=")) root = argument.slice("--root=".length);
    else if (argument.startsWith("--floor=")) floor = argument.slice("--floor=".length);
    else if (argument.startsWith("--lock=")) lock = argument.slice("--lock=".length);
    else if (argument.startsWith("--manifest=")) manifest = argument.slice("--manifest=".length);
    else throw new Error(`unknown argument '${argument}'`);
  }
  return { root: resolve(root), floor, lock, manifest };
}

function trackedFiles(root: string): string[] {
  const result = Bun.spawnSync(["git", "-C", root, "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    // Not "no lockfile": the inventory itself could not be taken.
    throw new Error(
      `git ls-files failed in ${root}: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter((path) => path !== "");
}

function readTrackedText(root: string, path: string): string {
  const absolute = join(root, path);
  if (!lstatSync(absolute).isFile()) throw new Error("not a regular file");
  return readFileSync(absolute, "utf8");
}

if (import.meta.main) {
  let args: Arguments;
  let tracked: string[];
  try {
    args = parseArguments(Bun.argv.slice(2));
    tracked = trackedFiles(args.root);
  } catch (error) {
    console.error(`LangGraph advisory floor: ${(error as Error).message}`);
    process.exit(2);
  }
  const failures: string[] = [];

  let floor: Floor = { readOn: "", entries: [], denied: [], errors: [] };
  let floorRead = false;
  if (!tracked.includes(args.floor)) {
    failures.push(`${args.floor}: the floor is not a tracked file of ${args.root}`);
  } else {
    try {
      floor = parseFloor(readTrackedText(args.root, args.floor));
      floorRead = true;
    } catch (error) {
      failures.push(`${args.floor}: floor unreadable (${(error as Error).message})`);
    }
  }
  for (const error of floor.errors) failures.push(`${args.floor}: ${error}`);
  // An empty `entries` array lands here too: every required entry is then absent.
  if (floorRead && floor.errors.length === 0) failures.push(...missingRequired(floor.entries));

  let lock: readonly LockEntry[] = [];
  if (!tracked.includes(args.lock)) {
    failures.push(`${args.lock}: the lockfile is not a tracked file of ${args.root}`);
  } else {
    let reading: LockReading;
    try {
      reading = readLockfile(args.lock, readTrackedText(args.root, args.lock));
    } catch (error) {
      reading = { error: `unreadable (${(error as Error).message})` };
    }
    if ("error" in reading) failures.push(`${args.lock}: lockfile ${reading.error}`);
    else lock = reading.entries;
  }

  let declared: string[] = [];
  if (!tracked.includes(args.manifest)) {
    failures.push(`${args.manifest}: the manifest is not a tracked file of ${args.root}`);
  } else {
    try {
      const reading = declaredNames(readTrackedText(args.root, args.manifest));
      if ("error" in reading) failures.push(`${args.manifest}: manifest ${reading.error}`);
      else declared = reading.names;
    } catch (error) {
      failures.push(`${args.manifest}: manifest unreadable (${(error as Error).message})`);
    }
  }

  const evaluation = evaluate(floor.entries, floor.denied, lock, args.lock);
  failures.push(...evaluation.defects);

  const graphPaths = [args.manifest, args.lock];
  const scope = sweepOutsideGraph(args.root, tracked, graphPaths);
  const scopeDefects = scopeFailures(scope, graphPaths);
  failures.push(...scopeDefects);

  const declaredFamily = declared.filter((name) => FAMILY.test(name));
  const resolvedFamily = lock.filter((entry) => FAMILY.test(entry.name));
  const covered = new Set(floor.entries.map((entry) => entry.package));
  const coveredFamily = resolvedFamily.filter((entry) => covered.has(entry.name)).length;
  // Vacuous only if the graph workspace is empty AND nothing of the family hides elsewhere: the
  // sweep's failure replaces the word, it does not accompany it.
  const vacuous =
    declaredFamily.length === 0 && resolvedFamily.length === 0 && scopeDefects.length === 0;
  if (declaredFamily.length > 0 && evaluation.resolvedRows === 0 && floor.entries.length > 0) {
    failures.push(
      `${args.manifest} declares ${declaredFamily.join(", ")} but ${args.lock} resolves no floor package: ` +
        "the lockfile is out of step with the manifest, or the wrong lockfile",
    );
  }

  const packages = new Set(floor.entries.map((entry) => entry.package)).size;
  console.log(
    `LangGraph advisory floor: ${floor.entries.length} entr(ies) over ${packages} package(s) and ` +
      `${floor.denied.length} denied version(s) from ${args.floor} read on ${floor.readOn || "?"}; ` +
      `${REQUIRED.length - missingRequired(floor.entries).length} of ${REQUIRED.length} required entr(ies) present`,
  );
  console.log(
    `LangGraph advisory floor: ${args.lock}: ${lock.length} entr(ies) listed, ` +
      `${resolvedFamily.length} in the publisher family (${coveredFamily} covered by an entry); ` +
      `${evaluation.entriesCompared} entry-by-lock comparison(s); ${evaluation.resolvedRows} entr(ies) ` +
      `resolved, ${evaluation.absentRows} absent from the lockfile, ${evaluation.defects.length} below the floor, denied or not comparable`,
  );
  console.log(`LangGraph advisory floor: ${scopeVolume(scope)}`);
  console.log(`LangGraph advisory floor: ${SCOPE_NOT_SEEN}`);
  if (vacuous) {
    console.log(
      `LangGraph advisory floor: vacuous — ${args.manifest} declares no package of the publisher ` +
        "family and the lockfile resolves none: the floor holds with nothing to compare, and binds " +
        "by itself as soon as one is declared",
    );
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`LangGraph advisory floor: ${failure}`);
    console.error(`LangGraph advisory floor failed: ${failures.length} problem(s).`);
    process.exit(1);
  }
  console.log(
    "LangGraph advisory floor verified: every resolved floor package is at or above its minimum, none is a denied version.",
  );
}
