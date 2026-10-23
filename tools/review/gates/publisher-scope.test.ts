// Proof of CA-18, test `publisher-scope`: a package of the publisher family declared in a tracked
// package.json, or resolved in a tracked lockfile, outside tools/review/package.json and
// tools/review/bun.lock, fails both advisory instruments instead of leaving them "vacuous" / "not
// applicable" (ADR-0058 section 3, condition 1: EVERY resolved version of the graph is at or above
// the fixed version; docs/prd.md section 9 puts the graph in the Bun workspace of tools/review).
// Method and harness: harness.ts. The sweep lives in publisher-scope.ts and is shared by the two
// gates, so each case runs against BOTH, and its mutant lands in the module (third element of the
// mutation) or at the call site in the gate.

import { describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { accepts, type Case, type Entry, HERE, prove, type Run, refuses, rmFile } from "./harness";

const FLOOR_GATE = join(HERE, "check-advisory-floor.ts");
const OSV_GATE = join(HERE, "check-osv-advisories.ts");
const MODULE = "publisher-scope.ts";

const FLOOR = "tools/review/advisories.v1.json";
const LOCK = "tools/review/bun.lock";
const MANIFEST = "tools/review/package.json";

const GRAPH = "@langchain/langgraph";
const BOTH_FILES = `(${MANIFEST}, ${LOCK})`;

/** The committed floor: the gate requires its six entries, whatever the case is about. */
const FLOOR_DATA = readFileSync(join(HERE, "..", "advisories.v1.json"), "utf8");

const manifestOf = (sections: Record<string, Record<string, string>>) =>
  `${JSON.stringify({ name: "x", ...sections })}\n`;

function bunLock(packages: Record<string, string>): string {
  const lines = Object.entries(packages).map(
    ([key, spec]) =>
      `    ${JSON.stringify(key)}: [${JSON.stringify(spec)}, "", {}, "sha512-AAAA"],`,
  );
  return `{\n  "lockfileVersion": 2,\n  "workspaces": { "": { "name": "x" } },\n  "packages": {\n${lines.join("\n")}\n  },\n}\n`;
}

const lockOf = (versions: Record<string, string>) =>
  bunLock(Object.fromEntries(Object.entries(versions).map(([name, v]) => [name, `${name}@${v}`])));

/** The graph workspace with nothing of the family in it: both gates are vacuous on it alone. */
const EMPTY_GRAPH: Record<string, Entry> = {
  [FLOOR]: FLOOR_DATA,
  [LOCK]: lockOf({ left: "1.0.0" }),
  [MANIFEST]: manifestOf({ dependencies: { ajv: "8.20.0" } }),
};

/** The graph workspace with the graph in it, at a version above every minimum. */
const GRAPH_IN_PLACE: Record<string, Entry> = {
  [FLOOR]: FLOOR_DATA,
  [LOCK]: lockOf({ [GRAPH]: "1.5.2" }),
  [MANIFEST]: manifestOf({ dependencies: { [GRAPH]: "1.5.2" } }),
};

const outside = (files: Record<string, Entry>): Record<string, Entry> => ({
  ...EMPTY_GRAPH,
  ...files,
});

const DECLARES = manifestOf({ dependencies: { [GRAPH]: "1.4.20" } });
const RESOLVES = bunLock({ [GRAPH]: `${GRAPH}@1.4.20` });

/** The message of the sweep for one reference: file, package, and where the graph belongs. */
const OUTSIDE = (location: string, name: string) =>
  `${location}: ${name} is a package of the publisher family outside the graph workspace: ` +
  `docs/prd.md section 9 places the graph in the Bun workspace of tools/review ${BOTH_FILES}`;

const SCOPE_LINE =
  /scope: (\d+) tracked file\(s\): (\d+) of the graph workspace, (\d+) manifest\(s\) and (\d+) lockfile\(s\) outside it examined, (\d+) out of scope, (\d+) unreadable;/;

/** Exit 0, and the five counters of the sweep sum to the tracked files it printed. */
function scopeSumsToTracked(run: Run): boolean {
  const match = run.out.match(SCOPE_LINE);
  if (match === null || run.exit !== 0) return false;
  const [tracked, ...rest] = match.slice(1).map(Number) as [number, ...number[]];
  return rest.reduce((sum, count) => sum + count, 0) === tracked;
}

const noScanner = (_repo: string) => ["--osv-scanner=/no/such/osv-scanner"];

/** The graph in its workspace: the floor compares it (exit 0); osv then needs a scanner (exit 1). */
const graphInPlaceHolds = (gate: "floor" | "osv") => (run: Run) =>
  gate === "floor"
    ? accepts("2 of the graph workspace, 0 manifest(s) and 0 lockfile(s) outside it examined")(run)
    : refuses("osv-scanner unavailable")(run) && !run.err.includes("outside the graph workspace");

const GATES = [
  { name: "floor", gate: FLOOR_GATE, args: [] as string[] },
  { name: "osv", gate: OSV_GATE, args: noScanner },
] as const;

/** The cases about the sweep itself: one definition, run against each gate, mutant in the module. */
function sweepCases(gate: "floor" | "osv"): Case[] {
  return [
    {
      name: "the package declared in a package.json at the root",
      files: outside({ "package.json": DECLARES }),
      holds: refuses(OUTSIDE("package.json:1", GRAPH)),
      mutation: ["found.push(", "[].push(", MODULE],
    },
    {
      name: "the package declared in a package.json of a nested workspace",
      files: outside({ "packages/app/package.json": DECLARES }),
      holds: refuses(OUTSIDE("packages/app/package.json:1", GRAPH)),
      mutation: ['new Set(["package.json"])', 'new Set(["package.json-unread"])', MODULE],
    },
    {
      name: "the package resolved in a bun.lock at the root, the manifest being clean",
      files: outside({ "bun.lock": RESOLVES }),
      holds: refuses(
        /(?<![\w/])bun\.lock:\d+: @langchain\/langgraph is a package of the publisher family outside the graph workspace/,
      ),
      mutation: ['  "bun.lock",\n', '  "bun.lock-unread",\n', MODULE],
    },
    {
      name: "the package resolved in a lockfile of another format",
      files: outside({
        "package-lock.json": `{ "packages": { "node_modules/${GRAPH}": { "version": "1.4.20" } } }\n`,
      }),
      holds: refuses(OUTSIDE("package-lock.json:1", GRAPH)),
      mutation: ['"package-lock.json",', '"package-lock.json-unread",', MODULE],
    },
    {
      name: "the bare package of the family is a reference",
      files: outside({ "package.json": manifestOf({ dependencies: { langchain: "0.3.0" } }) }),
      holds: refuses(OUTSIDE("package.json:1", "langchain")),
      mutation: ["|(?<![\\w@.~-])langchain(?![\\w.~-])", "", MODULE],
    },
    {
      name: "a name that only contains the bare name is not a reference (after it)",
      files: outside({
        "package.json": manifestOf({ dependencies: { "langchain-community": "1.0.0" } }),
      }),
      holds: accepts("0 publisher-family reference(s) outside the graph workspace"),
      mutation: ["langchain(?![\\w.~-])", "langchain", MODULE],
    },
    {
      name: "a name that only contains the bare name is not a reference (before it)",
      files: outside({ "package.json": manifestOf({ dependencies: { "my-langchain": "1.0.0" } }) }),
      holds: accepts("0 publisher-family reference(s) outside the graph workspace"),
      mutation: ["(?<![\\w@.~-])langchain", "langchain", MODULE],
    },
    {
      name: "the graph in its own workspace is not swept: it is compared, not refused",
      files: GRAPH_IN_PLACE,
      holds: graphInPlaceHolds(gate),
      mutation: ["if (graphPaths.includes(path)) {", "if (false) {", MODULE],
    },
    {
      name: "the counters sum to the tracked files",
      files: outside({
        "package.json": manifestOf({ dependencies: { ajv: "8.20.0" } }),
        "bun.lock": lockOf({ left: "1.0.0" }),
        "packages/app/package.json": manifestOf({ dependencies: { ajv: "8.20.0" } }),
        "README.md": "prose\n",
        "src/a.ts": "export {};\n",
      }),
      holds: (run) =>
        scopeSumsToTracked(run) &&
        run.out.includes(
          "8 tracked file(s): 2 of the graph workspace, 2 manifest(s) and 1 lockfile(s) outside it examined, 3 out of scope, 0 unreadable",
        ),
      mutation: ["outOfScope += 1;", "outOfScope += 2;", MODULE],
    },
    {
      name: "a tracked manifest behind a link is a failure, not a zero",
      files: outside({
        "pkg/package.json": { link: "../tools/review/package.json" },
      }),
      holds: refuses(
        "pkg/package.json (not a regular file): a tracked manifest or lockfile outside the graph that was not read",
      ),
      mutation: ["if (!lstatSync(join(root, path)).isFile()) {", "if (false) {", MODULE],
    },
    {
      name: "a tracked lockfile that cannot be read is a failure, not a zero",
      files: outside({ "pkg/bun.lock": lockOf({ left: "1.0.0" }) }),
      prepare: (repo) => rmFile(repo, "pkg/bun.lock"),
      holds: refuses(
        "pkg/bun.lock (unreadable): a tracked manifest or lockfile outside the graph that was not read",
      ),
      mutation: ["} catch {\n      unreadable.push(", "} catch {\n      [].push(", MODULE],
    },
  ];
}

for (const { name, gate, args } of GATES) {
  describe(`publisher-scope: the ${name} gate sweeps every tracked manifest and lockfile`, () => {
    prove(
      gate,
      sweepCases(name).map((c): Case => ({ ...c, args })),
    );
  });
}

describe("publisher-scope: the floor gate says what it did not compare", () => {
  prove(FLOOR_GATE, [
    {
      name: "a package outside the graph workspace is a failure, and the floor is not called vacuous",
      files: outside({ "package.json": DECLARES, "bun.lock": RESOLVES }),
      holds: (run) =>
        refuses(OUTSIDE("package.json:1", GRAPH))(run) && !run.out.includes("vacuous"),
      mutation: [
        "resolvedFamily.length === 0 && scopeDefects.length === 0;",
        "resolvedFamily.length === 0;",
      ],
    },
    {
      name: "the sweep is a failure of the floor gate itself, not only of the module",
      files: outside({ "package.json": DECLARES }),
      holds: refuses("LangGraph advisory floor failed: 1 problem(s)."),
      mutation: ["failures.push(...scopeDefects);", "void scopeDefects;"],
    },
    {
      name: "with nothing of the family anywhere it stays vacuous, and prints the volume swept",
      files: EMPTY_GRAPH,
      holds: accepts(
        "vacuous",
        "scope: 3 tracked file(s): 2 of the graph workspace, 0 manifest(s) and 0 lockfile(s) outside it examined, 1 out of scope, 0 unreadable; 0 publisher-family reference(s)",
      ),
      mutation: ["{scopeVolume(scope)}`);", "{scopeVolume(scope)}`.slice(0, 0));"],
    },
    {
      name: "the run declares what the sweep does not see",
      files: EMPTY_GRAPH,
      holds: accepts("scope: not seen — an untracked manifest or lockfile"),
      mutation: ["{SCOPE_NOT_SEEN}`);", "{SCOPE_NOT_SEEN}`.slice(0, 0));"],
    },
  ]);
});

describe("publisher-scope: the osv gate says what it did not scan", () => {
  prove(OSV_GATE, [
    {
      name: "a package outside the graph workspace is a failure, not 'not applicable'",
      files: outside({ "package.json": DECLARES }),
      args: noScanner,
      holds: (run) =>
        refuses(OUTSIDE("package.json:1", GRAPH), "OSV advisories failed: 1 problem(s).")(run) &&
        !run.out.includes("not applicable"),
      mutation: ["failures.push(...scopeFailures(scope, graphPaths));", "void scope;"],
    },
    {
      name: "with nothing of the family anywhere it stays not applicable, and prints the volume swept",
      files: EMPTY_GRAPH,
      args: noScanner,
      holds: accepts(
        "not applicable",
        "scope: 3 tracked file(s): 2 of the graph workspace, 0 manifest(s) and 0 lockfile(s) outside it examined, 1 out of scope, 0 unreadable; 0 publisher-family reference(s)",
      ),
      mutation: ["{scopeVolume(scope)}`);", "{scopeVolume(scope)}`.slice(0, 0));"],
    },
    {
      name: "the run declares what the sweep does not see",
      files: EMPTY_GRAPH,
      args: noScanner,
      holds: accepts("scope: not seen — an untracked manifest or lockfile"),
      mutation: ["{SCOPE_NOT_SEEN}`);", "{SCOPE_NOT_SEEN}`.slice(0, 0));"],
    },
  ]);
});
