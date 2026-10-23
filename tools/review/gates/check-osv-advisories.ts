// Entry gate for the LangGraph review fan-out — CA-18, first instrument (ADR-0058 section 3,
// condition 1): `osv-scanner` offline on `tools/review/bun.lock`, against an advisory database
// whose synchronisation date is printed, and which fails when it is absent or older than seven
// days. The second instrument, the versioned floor, is check-advisory-floor.ts.
//
// No template exists for this instrument. Self-contained on purpose: one file, `node:` and `Bun`
// only, plus publisher-scope.ts (itself `node:` only) for the sweep the two advisory gates share,
// so that a mutant of it can be run alone with that module (see advisory-floor.test.ts).
//
// Usage: bun check-osv-advisories.ts [--root=<dir>] [--lock=<path>] [--manifest=<path>]
//                                    [--db-dir=<path>] [--osv-scanner=<binary>]
//
//   --root         the repository to examine (default: the current directory); a git work tree.
//   --lock         the resolved graph (default: DEFAULT_LOCK). Tracked, and a `bun.lock`.
//   --manifest     the manifest of the graph (default: DEFAULT_MANIFEST). Tracked.
//   --db-dir       where the advisory database lives (default: DEFAULT_DB_DIR, relative to the
//                  root, ignored by git). The gate passes it to the scanner as its cache
//                  directory, so that the path it dates is the path the scanner reads.
//   --osv-scanner  the binary (default: `osv-scanner` on PATH).
//
// The gate never downloads: it is a correctness gate, and a verdict that depends on a service's
// availability or quota is a red that means nothing. The database is synchronised by a separate
// command (the `sync:osv-advisory-db` script), whose date this gate then reads. The date is the
// modification time of the database file: the day it was downloaded, not the day the database was
// last rebuilt upstream.
//
// What "unavailable" is. When the instrument applies, each of these is a failure with its own
// message, never a green and never a zero: no scanner binary, no database file, a database older
// than seven days or dated in the future, a scanner that exits with anything but 0 (clean) or 1
// (advisories found), a report that does not parse, a report that examined 0 packages, a report
// that did not examine a package of the publisher family that the lockfile lists, advisories found.
//
// When it applies. The graph of tools/review has no LangGraph package until WP-2: then there is
// no advisory of the publisher to look for, and requiring a scanner and a database would fail
// every repository that has nothing to scan. The gate says so on every run ("not applicable") and
// applies by itself as soon as the manifest declares a package of the publisher family, or the
// lockfile resolves one (a transitive arrival is caught too).
//
// Where the graph may live. docs/prd.md section 9 places it in the Bun workspace of tools/review,
// the manifest and the lockfile above, and they are the only files this instrument scans. A package
// of the family declared in any other tracked package.json, or resolved in any other tracked
// lockfile, is a graph that would never be scanned: the gate fails naming the file and the package
// instead of printing "not applicable" (publisher-scope.ts: the sweep, shared with
// check-advisory-floor.ts). The counters print the manifests and lockfiles examined and sum to the
// tracked files.

import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  FAMILY,
  SCOPE_NOT_SEEN,
  scopeFailures,
  scopeVolume,
  sweepOutsideGraph,
} from "./publisher-scope";

const DEFAULT_LOCK = "tools/review/bun.lock";
const DEFAULT_MANIFEST = "tools/review/package.json";
const DEFAULT_DB_DIR = ".cache/osv-advisory-db";

// Where the scanner keeps the npm database under its cache directory (osv-scanner 2.7.0, measured
// 2026-10-23). A layout that moves reads as "database absent": the safe direction.
const DATABASE_FILE = "osv-scalibr/npm/all.zip";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_TIMEOUT_MS = 300_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LockEntry {
  readonly name: string;
  readonly version: string;
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
  const packages = isRecord(parsed) && isRecord(parsed.packages) ? parsed.packages : {};
  if (Object.keys(packages).length === 0) return { error: "has no packages table" };
  const entries: LockEntry[] = [];
  for (const [where, value] of Object.entries(packages)) {
    const spec = Array.isArray(value) ? value[0] : undefined;
    const at = typeof spec === "string" ? spec.lastIndexOf("@") : -1;
    if (typeof spec !== "string" || at <= 0)
      return { error: `entry '${where}' has no name@version` };
    entries.push({ name: spec.slice(0, at), version: spec.slice(at + 1) });
  }
  return { entries };
}

/** Whether a manifest declares a package of the family, by key or by `npm:` alias target. */
export function declaresFamily(text: string): boolean | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `does not parse as JSON: ${(error as Error).message}` };
  }
  if (!isRecord(parsed)) return { error: "is not a JSON object" };
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "overrides",
    "resolutions",
  ]) {
    const table = parsed[section];
    if (!isRecord(table)) continue;
    for (const [key, value] of Object.entries(table)) {
      if (FAMILY.test(key)) return true;
      const alias = typeof value === "string" ? value.match(/^npm:(@?[^@]+)@/) : null;
      if (alias?.[1] !== undefined && FAMILY.test(alias[1])) return true;
    }
  }
  return false;
}

export interface Report {
  readonly examined: readonly LockEntry[];
  readonly advisories: readonly string[];
}

/** The scanner report (`--format json --all-packages`): every examined package, and its advisories. */
export function readReport(text: string): Report | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `report does not parse as JSON: ${(error as Error).message}` };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
    return { error: "report has no results array" };
  }
  const examined: LockEntry[] = [];
  const advisories: string[] = [];
  for (const result of parsed.results) {
    if (!isRecord(result) || !Array.isArray(result.packages)) {
      return { error: "report has a result without a packages array" };
    }
    for (const item of result.packages) {
      const info = isRecord(item) ? item.package : undefined;
      if (!isRecord(info) || typeof info.name !== "string" || typeof info.version !== "string") {
        return { error: "report has a package without name and version" };
      }
      examined.push({ name: info.name, version: info.version });
      const found =
        isRecord(item) && Array.isArray(item.vulnerabilities) ? item.vulnerabilities : [];
      for (const vulnerability of found) {
        const id = isRecord(vulnerability) ? vulnerability.id : undefined;
        advisories.push(`${info.name}@${info.version}: ${typeof id === "string" ? id : "(no id)"}`);
      }
    }
  }
  return { examined, advisories };
}

export interface Arguments {
  readonly root: string;
  readonly lock: string;
  readonly manifest: string;
  readonly dbDir: string;
  readonly scanner: string | undefined;
}

export function parseArguments(argv: readonly string[]): Arguments {
  let root = ".";
  let lock = DEFAULT_LOCK;
  let manifest = DEFAULT_MANIFEST;
  let dbDir = DEFAULT_DB_DIR;
  let scanner: string | undefined;
  for (const argument of argv) {
    if (argument.startsWith("--root=")) root = argument.slice("--root=".length);
    else if (argument.startsWith("--lock=")) lock = argument.slice("--lock=".length);
    else if (argument.startsWith("--manifest=")) manifest = argument.slice("--manifest=".length);
    else if (argument.startsWith("--db-dir=")) dbDir = argument.slice("--db-dir=".length);
    else if (argument.startsWith("--osv-scanner=")) {
      scanner = argument.slice("--osv-scanner=".length);
    } else throw new Error(`unknown argument '${argument}'`);
  }
  return { root: resolve(root), lock, manifest, dbDir: resolve(root, dbDir), scanner };
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

function firstLine(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim().split("\n")[0] ?? "";
}

/** The database file's date, or the reason it cannot serve as one. */
export function databaseAge(
  dbDir: string,
  now: number,
): { synced: Date; days: number } | { error: string } {
  const file = join(dbDir, DATABASE_FILE);
  let modified: number;
  try {
    modified = statSync(file).mtimeMs;
  } catch {
    return {
      error: `advisory database absent: ${file} does not exist (run the sync:osv-advisory-db script)`,
    };
  }
  const age = now - modified;
  const days = age / (24 * 60 * 60 * 1000);
  if (age < 0) {
    return { error: `advisory database dated in the future (${new Date(modified).toISOString()})` };
  }
  if (age > MAX_AGE_MS) {
    return {
      error: `advisory database synchronised ${new Date(modified).toISOString()}, ${days.toFixed(1)} days old: older than 7 days`,
    };
  }
  return { synced: new Date(modified), days };
}

if (import.meta.main) {
  let args: Arguments;
  let tracked: string[];
  try {
    args = parseArguments(Bun.argv.slice(2));
    tracked = trackedFiles(args.root);
  } catch (error) {
    console.error(`OSV advisories: ${(error as Error).message}`);
    process.exit(2);
  }
  const failures: string[] = [];

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

  let declares = false;
  if (!tracked.includes(args.manifest)) {
    failures.push(`${args.manifest}: the manifest is not a tracked file of ${args.root}`);
  } else {
    try {
      const reading = declaresFamily(readTrackedText(args.root, args.manifest));
      if (typeof reading === "object") failures.push(`${args.manifest}: manifest ${reading.error}`);
      else declares = reading;
    } catch (error) {
      failures.push(`${args.manifest}: manifest unreadable (${(error as Error).message})`);
    }
  }

  const graphPaths = [args.manifest, args.lock];
  const scope = sweepOutsideGraph(args.root, tracked, graphPaths);
  failures.push(...scopeFailures(scope, graphPaths));

  const resolvedFamily = lock.filter((entry) => FAMILY.test(entry.name));
  const applies = declares || resolvedFamily.length > 0;
  console.log(
    `OSV advisories: ${args.lock}: ${lock.length} entr(ies) listed, ${resolvedFamily.length} in the ` +
      `publisher family; ${args.manifest} ${declares ? "declares" : "declares no"} package of the family`,
  );
  console.log(`OSV advisories: ${scopeVolume(scope)}`);
  console.log(`OSV advisories: ${SCOPE_NOT_SEEN}`);

  if (failures.length === 0 && !applies) {
    console.log(
      "OSV advisories: not applicable — no package of the publisher family is declared or " +
        "resolved: no advisory of the publisher to look for, scanner and database not required; " +
        "applies by itself as soon as one is",
    );
    console.log("OSV advisories verified: not applicable, 0 package(s) scanned.");
  } else if (failures.length === 0) {
    // `Bun.which` resolves a bare name on PATH and accepts an absolute path only if executable.
    const scanner = Bun.which(args.scanner ?? "osv-scanner");
    const database = databaseAge(args.dbDir, Date.now());
    if (scanner === null) {
      failures.push(
        `osv-scanner unavailable: '${args.scanner ?? "osv-scanner"}' is not an executable on PATH`,
      );
    }
    if ("error" in database) failures.push(database.error);
    else {
      console.log(
        `OSV advisories: advisory database synchronised ${database.synced.toISOString()} ` +
          `(${database.days.toFixed(1)} day(s) old, limit 7)`,
      );
    }

    if (failures.length === 0 && scanner !== null) {
      const environment = { ...process.env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: args.dbDir };
      const version = Bun.spawnSync([scanner, "--version"], {
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      console.log(
        `OSV advisories: ${version.exitCode === 0 ? firstLine(version.stdout) : "osv-scanner version unreadable"}`,
      );
      const command = [
        scanner,
        "scan",
        "source",
        "--offline-vulnerabilities",
        "--all-packages",
        "--format",
        "json",
        "-L",
        join(args.root, args.lock),
      ];
      console.log(
        `OSV advisories: ${basename(scanner)} ${command.slice(1, -1).join(" ")} ${args.lock}`,
      );
      const run = Bun.spawnSync(command, {
        cwd: args.root,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
        timeout: SCAN_TIMEOUT_MS,
      });
      const code = run.exitCode;
      if (code !== 0 && code !== 1) {
        failures.push(
          `osv-scanner exited ${code === null ? "without a status (killed or timed out)" : code}: ${firstLine(run.stderr) || "no message"}`,
        );
      } else {
        const report = readReport(new TextDecoder().decode(run.stdout));
        if ("error" in report) failures.push(report.error);
        else {
          console.log(
            `OSV advisories: ${report.examined.length} package(s) examined by the scanner, ` +
              `${report.advisories.length} advisory finding(s)`,
          );
          if (report.examined.length === 0) {
            failures.push("the scanner examined 0 package(s): a scan of nothing is not a green");
          }
          for (const finding of report.advisories) failures.push(`advisory found: ${finding}`);
          if (code === 1 && report.advisories.length === 0) {
            failures.push("osv-scanner exited 1 but its report lists no advisory");
          }
          const seen = new Set(report.examined.map((entry) => `${entry.name}@${entry.version}`));
          for (const entry of resolvedFamily) {
            if (!seen.has(`${entry.name}@${entry.version}`)) {
              failures.push(
                `${entry.name}@${entry.version} is in ${args.lock} but the scanner did not examine it`,
              );
            }
          }
        }
      }
    }
    if (failures.length === 0) {
      console.log("OSV advisories verified: no advisory found in the offline database.");
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`OSV advisories: ${failure}`);
    console.error(`OSV advisories failed: ${failures.length} problem(s).`);
    process.exit(1);
  }
}
