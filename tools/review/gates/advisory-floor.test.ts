// Proof of CA-18, test `advisory-floor`: the two instruments that make versions fixed against the
// publisher's advisories a blocking check — the versioned floor `tools/review/advisories.v1.json`
// against the resolved lockfile (check-advisory-floor.ts), and `osv-scanner` offline against a
// dated advisory database (check-osv-advisories.ts). Method and harness: harness.ts.
//
// The osv instrument is driven here by a fake scanner (a shell script that prints a report and
// exits with a chosen code): the proof is of the gate's decisions — what it does with a missing
// binary, a missing or stale database, an advisory, a scan of nothing — not of the scanner. The
// real scanner is exercised by hand and the output is carried in the pull request.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type FloorEntry,
  missingRequired,
  parseFloor,
  REQUIRED,
  type RequiredEntry,
} from "./check-advisory-floor";
import {
  accepts,
  type Case,
  type Entry,
  HERE,
  newRepo,
  prove,
  refuses,
  rmFile,
  scratch,
  spawnClean,
  writeExecutable,
} from "./harness";

const FLOOR_GATE = join(HERE, "check-advisory-floor.ts");
const OSV_GATE = join(HERE, "check-osv-advisories.ts");

const FLOOR = "tools/review/advisories.v1.json";
const LOCK = "tools/review/bun.lock";
const MANIFEST = "tools/review/package.json";

const GRAPH = "@langchain/langgraph";
const CHECKPOINT = "@langchain/langgraph-checkpoint";
const CORE = "@langchain/core";
const SDK = "@langchain/langgraph-sdk";
const PUBLISHER = "langchain-ai/langgraphjs";

const entryOf = (required: RequiredEntry) => ({ ...required, source: PUBLISHER });

const floorText = (
  options: {
    entries?: readonly unknown[];
    denied?: readonly unknown[];
    without?: string;
    patch?: Record<string, unknown>;
  } = {},
) =>
  `${JSON.stringify({
    schema: "advisories.v1",
    readOn: "2026-10-23",
    entries: [
      ...REQUIRED.filter((required) => required.advisory !== options.without).map(entryOf),
      ...(options.entries ?? []),
    ],
    denied: options.denied ?? [
      { package: SDK, version: "2.0.0", advisory: "GHSA-432w-3h3v-2pv4", source: PUBLISHER },
    ],
    ...options.patch,
  })}\n`;

const manifestText = (sections: Record<string, Record<string, string>>) =>
  `${JSON.stringify({ name: "@libre-ai/review-tools", ...sections }, null, 2)}\n`;

function bunLock(packages: Record<string, string>): string {
  const lines = Object.entries(packages).map(
    ([key, spec]) =>
      `    ${JSON.stringify(key)}: [${JSON.stringify(spec)}, "", {}, "sha512-AAAA"],`,
  );
  return `{\n  "lockfileVersion": 2,\n  "workspaces": { "": { "name": "x" } },\n  "packages": {\n${lines.join("\n")}\n  },\n}\n`;
}

const lockOf = (versions: Record<string, string>) =>
  bunLock(Object.fromEntries(Object.entries(versions).map(([name, v]) => [name, `${name}@${v}`])));

/** The graph at versions above every minimum. */
const HEALTHY = { [GRAPH]: "1.5.2", [CORE]: "1.3.0", [CHECKPOINT]: "1.2.1", [SDK]: "1.12.6" };
/** The graph exactly at the highest minimum of each package. */
const AT_MINIMUM = { [GRAPH]: "1.4.21", [CORE]: "1.1.8", [CHECKPOINT]: "1.1.4", [SDK]: "1.12.3" };

const DECLARES_GRAPH = manifestText({ dependencies: { [GRAPH]: "1.5.2" } });
const DECLARES_NOTHING = manifestText({ dependencies: { ajv: "8.20.0" } });

interface Fixture {
  readonly floor?: string;
  readonly lock?: Record<string, string> | string;
  readonly manifest?: string;
}

function fixture(parts: Fixture = {}): Record<string, Entry> {
  const lock = parts.lock ?? HEALTHY;
  return {
    [FLOOR]: parts.floor ?? floorText(),
    [LOCK]: typeof lock === "string" ? lock : lockOf(lock),
    [MANIFEST]: parts.manifest ?? DECLARES_GRAPH,
  };
}

const BELOW = (name: string, version: string, minimum: string, advisory: string) =>
  `${LOCK}: ${name}@${version} (${name}) is below ${minimum} (${advisory})`;

// ---------------------------------------------------------------------------------------------
// Instrument 2: the floor
// ---------------------------------------------------------------------------------------------

const ORDER_BELOW = "Bun.semver.order(entry.version, row.minimum) < 0";

describe("advisory-floor: the floor is compared to the resolved lockfile", () => {
  prove(FLOOR_GATE, [
    {
      name: "a version equal to its minimum is accepted, and the volume is printed",
      files: fixture({ lock: AT_MINIMUM }),
      holds: accepts(
        "6 entr(ies) over 4 package(s) and 1 denied version(s) from tools/review/advisories.v1.json read on 2026-10-23",
        "6 of 6 required entr(ies) present",
        `${LOCK}: 4 entr(ies) listed, 4 in the publisher family (4 covered by an entry); 6 entry-by-lock comparison(s)`,
        "6 entr(ies) resolved, 0 absent from the lockfile, 0 below the floor",
      ),
      mutation: [ORDER_BELOW, "Bun.semver.order(entry.version, row.minimum) <= 0"],
    },
    {
      name: "a version below its minimum",
      files: fixture({ lock: { ...HEALTHY, [GRAPH]: "1.4.20" } }),
      holds: refuses(BELOW(GRAPH, "1.4.20", "1.4.21", "GHSA-wp87-994x-j95x")),
      mutation: [ORDER_BELOW, "false"],
    },
    {
      name: "a version that satisfies one advisory and not the other is below the higher one",
      files: fixture({ lock: { ...HEALTHY, [GRAPH]: "1.4.15" } }),
      holds: refuses(BELOW(GRAPH, "1.4.15", "1.4.21", "GHSA-wp87-994x-j95x")),
      mutation: [ORDER_BELOW, "false"],
    },
    {
      name: "versions compare as semver, not as strings",
      files: fixture({ lock: { ...HEALTHY, [GRAPH]: "1.4.9" } }),
      holds: refuses(`${GRAPH}@1.4.9 `),
      mutation: [ORDER_BELOW, "entry.version < row.minimum"],
    },
    {
      name: "a pre-release of the minimum is below it",
      files: fixture({ lock: { ...HEALTHY, [GRAPH]: "1.4.21-alpha.1" } }),
      holds: refuses(`${GRAPH}@1.4.21-alpha.1 `),
      mutation: [
        ORDER_BELOW,
        'Bun.semver.order(entry.version.split("-")[0] as string, row.minimum) < 0',
      ],
    },
    {
      name: "every resolved version counts, not the first one",
      files: fixture({
        lock: bunLock({
          [GRAPH]: `${GRAPH}@1.5.2`,
          [CORE]: `${CORE}@1.3.0`,
          [`worker/${CORE}`]: `${CORE}@1.1.7`,
        }),
      }),
      holds: refuses(`(worker/${CORE}) is below 1.1.8`),
      mutation: ["resolved += 1;", "resolved += 1; if (resolved > 1) continue;"],
    },
    {
      name: "an alias is judged under the real package name",
      files: fixture({
        lock: bunLock({ lg: `${GRAPH}@1.4.0`, [CORE]: `${CORE}@1.3.0` }),
      }),
      holds: refuses(`${GRAPH}@1.4.0 (lg) is below 1.4.21`),
      mutation: ["name: spec.slice(0, at)", "name: where"],
    },
    {
      name: "a floor package that is not a version cannot be compared",
      files: fixture({
        lock: bunLock({ [GRAPH]: `${GRAPH}@github:acme/graph`, [CORE]: `${CORE}@1.3.0` }),
      }),
      holds: refuses("is not a version this gate can compare to 1.4.21"),
      // Not `false`: Bun.semver.order throws on a non-version, so that mutant would crash. The
      // defect is skipped instead, which leaves the verdict green.
      mutation: [
        "if (!RESOLVED_VERSION.test(entry.version)) {",
        "if (!RESOLVED_VERSION.test(entry.version)) { continue;",
      ],
    },
    {
      name: "a package the lockfile does not resolve satisfies its row and is counted absent",
      files: fixture({ lock: { [GRAPH]: "1.5.2" } }),
      holds: accepts("2 entr(ies) resolved, 4 absent from the lockfile"),
      mutation: ["if (resolved === 0) absentRows += 1;", "if (false) absentRows += 1;"],
    },
    {
      name: "the comparisons are counted",
      files: fixture(),
      holds: accepts("6 entry-by-lock comparison(s)"),
      mutation: ["entriesCompared += 1;", "entriesCompared += 0;"],
    },
    {
      name: "a package that arrives transitively is judged like a declared one",
      files: fixture({ manifest: DECLARES_NOTHING, lock: { ...HEALTHY, [GRAPH]: "1.4.20" } }),
      holds: refuses(BELOW(GRAPH, "1.4.20", "1.4.21", "GHSA-wp87-994x-j95x")),
      mutation: ["failures.push(...evaluation.defects);", "failures.push();"],
    },
  ]);
});

describe("advisory-floor: a version that no minimum can express is denied", () => {
  prove(FLOOR_GATE, [
    {
      name: "the sdk 2.0.0 line passes every minimum and is refused as a denied version",
      files: fixture({ lock: { ...HEALTHY, [SDK]: "2.0.0" } }),
      holds: refuses(`${SDK}@2.0.0 (${SDK}) is a denied version`, "GHSA-432w-3h3v-2pv4"),
      mutation: ["entry.name === ban.package && entry.version === ban.version", "false"],
    },
    {
      name: "a denied version is exact: the next patch version is not refused",
      files: fixture({ lock: { ...HEALTHY, [SDK]: "2.0.1" } }),
      holds: accepts("0 below the floor, denied or not comparable"),
      mutation: [
        "entry.name === ban.package && entry.version === ban.version",
        "entry.name === ban.package",
      ],
    },
  ]);
});

describe("advisory-floor: the data file cannot be emptied or lowered silently", () => {
  const WITHOUT_CORE = "GHSA-r399-636x-v7f6";
  const CALL =
    "if (floorRead && floor.errors.length === 0) failures.push(...missingRequired(floor.entries));";
  prove(FLOOR_GATE, [
    {
      name: "removing a required entry from the file turns the gate red",
      files: fixture({ floor: floorText({ without: WITHOUT_CORE }) }),
      holds: refuses(`required entry ${CORE} 1.1.8 ${WITHOUT_CORE} is absent`),
      mutation: [CALL, "if (false) failures.push(...missingRequired(floor.entries));"],
    },
    {
      name: "emptying the entries turns the gate red, entry by entry",
      files: fixture({
        floor: `${JSON.stringify({ schema: "advisories.v1", readOn: "2026-10-23", entries: [], denied: [] })}\n`,
      }),
      holds: (run) =>
        refuses(...REQUIRED.map((required) => `required entry ${required.package} `))(run) &&
        run.out.includes("0 of 6 required entr(ies) present"),
      mutation: [CALL, "if (false) failures.push(...missingRequired(floor.entries));"],
    },
    {
      name: "a required entry kept under a lower minimum is refused with both numbers",
      files: (() => {
        const lowered = REQUIRED.map((required) => ({
          ...entryOf(required),
          minimum: required.advisory === "GHSA-wp87-994x-j95x" ? "1.4.0" : required.minimum,
        }));
        return fixture({ floor: floorText({ patch: { entries: lowered } }) });
      })(),
      holds: refuses(
        `required entry ${GRAPH} GHSA-wp87-994x-j95x has minimum 1.4.0, below the required 1.4.21`,
      ),
      mutation: ["Bun.semver.order(entry.minimum, required.minimum) < 0", "false"],
    },
    {
      name: "an entry added to the file binds the lockfile without a code edit",
      files: fixture({
        floor: floorText({
          entries: [
            {
              package: GRAPH,
              minimum: "1.9.0",
              advisory: "GHSA-2222-3333-4444",
              source: PUBLISHER,
            },
          ],
        }),
      }),
      holds: refuses(BELOW(GRAPH, "1.5.2", "1.9.0", "GHSA-2222-3333-4444")),
      mutation: [
        "for (const row of entries) {",
        "for (const row of entries.filter((r) => REQUIRED.some((q) => q.advisory === r.advisory))) {",
      ],
    },
  ]);
});

describe("advisory-floor: the floor does not bind the lockfile to nothing", () => {
  prove(FLOOR_GATE, [
    {
      name: "a manifest that declares the package while the lockfile resolves none is a failure",
      files: fixture({ lock: { left: "1.0.0" } }),
      holds: refuses(
        "declares @langchain/langgraph but tools/review/bun.lock resolves no floor package",
      ),
      mutation: [
        "declaredFamily.length > 0 && evaluation.resolvedRows === 0 && floor.entries.length > 0",
        "false",
      ],
    },
    ...(
      [
        ["dependencies", { dependencies: { [GRAPH]: "1.5.2" } }],
        ["devDependencies", { devDependencies: { [CORE]: "1.3.0" } }],
        ["optionalDependencies", { optionalDependencies: { [CORE]: "1.3.0" } }],
        ["peerDependencies", { peerDependencies: { [CORE]: "1.3.0" } }],
        ["overrides", { overrides: { [CORE]: "1.3.0" } }],
        ["resolutions", { resolutions: { [CORE]: "1.3.0" } }],
      ] as const
    ).map(
      ([section, sections]): Case => ({
        name: `a package declared under ${section} makes the floor bind`,
        files: fixture({ manifest: manifestText(sections), lock: { left: "1.0.0" } }),
        holds: refuses("resolves no floor package"),
        mutation: [`"${section}",`, `"unread-${section}",`],
      }),
    ),
    {
      name: "a package declared through an npm alias makes the floor bind",
      files: fixture({
        manifest: manifestText({ dependencies: { graph: `npm:${GRAPH}@1.5.2` } }),
        lock: { left: "1.0.0" },
      }),
      holds: refuses("resolves no floor package"),
      mutation: ["if (alias?.[1] !== undefined) names.add(alias[1]);", "void alias;"],
    },
    {
      name: "with no package of the family declared or resolved the floor is vacuous, and says so",
      files: fixture({ manifest: DECLARES_NOTHING, lock: { left: "1.0.0" } }),
      holds: accepts("vacuous", "0 in the publisher family", "6 absent"),
      mutation: [
        "const vacuous = declaredFamily.length === 0 && resolvedFamily.length === 0;",
        "const vacuous = false;",
      ],
    },
  ]);
});

describe("advisory-floor: the floor is a tracked, schema-checked data file", () => {
  const mutateFloorRow = (anchor: string): readonly [string, string] => [anchor, "false"];
  prove(FLOOR_GATE, [
    {
      name: "a floor that is not a tracked file is not policy",
      files: { [LOCK]: lockOf(HEALTHY), [MANIFEST]: DECLARES_GRAPH },
      holds: refuses(`${FLOOR}: the floor is not a tracked file`),
      mutation: ["!tracked.includes(args.floor)", "false"],
    },
    {
      name: "a tracked floor that cannot be read is a failure",
      files: fixture(),
      prepare: (repo) => rmFile(repo, FLOOR),
      holds: refuses(`${FLOOR}: floor unreadable`),
      mutation: ["floor = parseFloor(readTrackedText(args.root, args.floor));", "floor = floor;"],
    },
    {
      name: "a floor that does not parse as JSON",
      files: fixture({ floor: "{{{\n" }),
      holds: refuses(`${FLOOR}: does not parse as JSON`),
      mutation: [
        "parsed = JSON.parse(text);\n  } catch (error) {\n    return { ...none,",
        "parsed = {};\n  } catch (error) {\n    return { ...none,",
      ],
    },
    {
      name: "a floor that is not an object",
      files: fixture({ floor: "[]\n" }),
      holds: refuses("is not a JSON object"),
      mutation: ["if (!isRecord(parsed)) return { ...none", "if (false) return { ...none"],
    },
    {
      name: "a floor of another schema",
      files: fixture({ floor: floorText({ patch: { schema: "advisories.v0" } }) }),
      holds: refuses("schema must be 'advisories.v1'"),
      mutation: mutateFloorRow('parsed.schema !== "advisories.v1"'),
    },
    {
      name: "a floor with no valid readOn date",
      files: fixture({ floor: floorText({ patch: { readOn: "yesterday" } }) }),
      holds: refuses("readOn must be a YYYY-MM-DD date"),
      mutation: ["READ_ON.test(parsed.readOn)", "true"],
    },
    {
      name: "a floor with an unknown top-level key",
      files: fixture({ floor: floorText({ patch: { note: "x" } }) }),
      holds: refuses("file: unknown key 'note'"),
      mutation: ["unexpected !== undefined) errors.push(`file:", "false) errors.push(`file:"],
    },
    {
      name: "a floor whose entries are not an array",
      files: fixture({ floor: floorText({ patch: { entries: {} } }) }),
      holds: refuses("'entries' must be an array"),
      mutation: mutateFloorRow("!Array.isArray(parsed.entries)"),
    },
    {
      name: "a floor whose denied versions are not an array",
      files: fixture({ floor: floorText({ patch: { denied: {} } }) }),
      holds: refuses("'denied' must be an array"),
      mutation: mutateFloorRow("!Array.isArray(parsed.denied)"),
    },
    {
      name: "an entry that is not an object",
      files: fixture({ floor: floorText({ entries: ["x"] }) }),
      holds: refuses("entries[6]: expected an object"),
      mutation: mutateFloorRow("!isRecord(item)"),
    },
    {
      name: "an entry with an unknown key",
      files: fixture({
        floor: floorText({
          entries: [
            {
              package: GRAPH,
              minimum: "1.9.0",
              advisory: "GHSA-2222-3333-4444",
              source: PUBLISHER,
              why: "x",
            },
          ],
        }),
      }),
      holds: refuses("entries[6]: unknown key 'why'"),
      mutation: ["unexpected !== undefined) return", "false) return"],
    },
    {
      name: "a name that is not a package name",
      files: fixture({
        floor: floorText({
          entries: [
            {
              package: "Not_A_Package",
              minimum: "1.0.0",
              advisory: "GHSA-2222-3333-4444",
              source: PUBLISHER,
            },
          ],
        }),
      }),
      holds: refuses("package 'Not_A_Package' is not a package name"),
      mutation: mutateFloorRow("!PACKAGE_NAME.test(name)"),
    },
    {
      name: "a minimum that is not an x.y.z version",
      // The lockfile does not resolve the package: a mutant that lets the minimum through is not
      // stopped by a crash of the version comparison, only by this check.
      files: fixture({
        manifest: DECLARES_NOTHING,
        lock: { left: "1.0.0" },
        floor: floorText({
          entries: [
            {
              package: GRAPH,
              minimum: "^1.9.0",
              advisory: "GHSA-2222-3333-4444",
              source: PUBLISHER,
            },
          ],
        }),
      }),
      holds: refuses("minimum '^1.9.0' is not an x.y.z version"),
      mutation: mutateFloorRow("!SEMVER_TRIPLE.test(version)"),
    },
    {
      name: "an advisory id that is not a GHSA identifier",
      files: fixture({
        floor: floorText({
          entries: [
            { package: GRAPH, minimum: "1.9.0", advisory: "CVE-2025-68665", source: PUBLISHER },
          ],
        }),
      }),
      holds: refuses("advisory 'CVE-2025-68665' is not a GHSA identifier"),
      mutation: mutateFloorRow("!ADVISORY_ID.test(advisory)"),
    },
    {
      name: "a source that is not an owner/repository",
      files: fixture({
        floor: floorText({
          entries: [
            {
              package: GRAPH,
              minimum: "1.9.0",
              advisory: "GHSA-2222-3333-4444",
              source: "somewhere",
            },
          ],
        }),
      }),
      holds: refuses("source 'somewhere' is not an owner/repository"),
      mutation: mutateFloorRow("!SOURCE_REPOSITORY.test(source)"),
    },
    {
      name: "the same package and advisory twice",
      files: fixture({
        floor: floorText({
          entries: [
            { package: CORE, minimum: "1.1.9", advisory: "GHSA-r399-636x-v7f6", source: PUBLISHER },
          ],
        }),
      }),
      holds: refuses(`entries[6]: ${CORE} GHSA-r399-636x-v7f6 is already an entry`),
      mutation: ["if (seen.has(", "if (false && seen.has("],
    },
    {
      name: "a denied row without a version",
      files: fixture({
        floor: floorText({
          denied: [{ package: SDK, advisory: "GHSA-432w-3h3v-2pv4", source: PUBLISHER }],
        }),
      }),
      holds: refuses("denied[0]: version 'undefined' is not an x.y.z version"),
      mutation: ["if (defect !== null) errors.push(defect);", "if (false) errors.push(defect);"],
    },
    {
      name: "a floor kept elsewhere is named by --floor",
      files: { ...fixture(), "ci/floor.json": floorText() },
      args: ["--floor=ci/floor.json"],
      holds: accepts("from ci/floor.json"),
      mutation: ['else if (argument.startsWith("--floor="))', "else if (false)"],
    },
  ]);
});

describe("advisory-floor: fails closed on what it cannot read", () => {
  prove(FLOOR_GATE, [
    {
      name: "a lockfile that is not tracked",
      files: { [FLOOR]: floorText(), [MANIFEST]: DECLARES_GRAPH },
      holds: refuses(`${LOCK}: the lockfile is not a tracked file`),
      mutation: ["!tracked.includes(args.lock)", "false"],
    },
    {
      name: "a tracked lockfile that cannot be read",
      files: fixture(),
      prepare: (repo) => rmFile(repo, LOCK),
      holds: refuses(`${LOCK}: lockfile unreadable`),
      mutation: [
        "reading = readLockfile(args.lock, readTrackedText(args.root, args.lock));",
        "reading = { entries: [] };",
      ],
    },
    {
      name: "a bun.lock that does not parse as JSONC",
      files: fixture({ lock: "{{{\n" }),
      holds: refuses(`${LOCK}: lockfile does not parse as JSONC`),
      mutation: ["parsed = Bun.JSONC.parse(text);", "parsed = {};"],
    },
    {
      name: "a bun.lock with no packages table",
      files: fixture({ lock: '{"lockfileVersion":2}\n' }),
      holds: refuses(`${LOCK}: lockfile has no packages table`),
      mutation: ["if (Object.keys(packages).length === 0) return", "if (false) return"],
    },
    {
      name: "a bun.lock entry without name@version",
      files: fixture({ lock: bunLock({ [GRAPH]: `${GRAPH}@1.5.2`, odd: "@langchain/odd" }) }),
      holds: refuses("entry 'odd' has no name@version"),
      mutation: ["at <= 0", "false"],
    },
    {
      name: "a lockfile of a format this gate does not read",
      files: { ...fixture(), "tools/review/yarn.lock": "x\n" },
      args: ["--lock=tools/review/yarn.lock"],
      holds: refuses("lockfile format 'yarn.lock' is not read by this gate"),
      mutation: ['if (name !== "bun.lock")', "if (false)"],
    },
    {
      name: "a manifest that is not tracked",
      files: { [FLOOR]: floorText(), [LOCK]: lockOf(HEALTHY) },
      holds: refuses(`${MANIFEST}: the manifest is not a tracked file`),
      mutation: ["!tracked.includes(args.manifest)", "false"],
    },
    {
      name: "a manifest that does not parse",
      files: fixture({ manifest: "{{{\n" }),
      holds: refuses(`${MANIFEST}: manifest does not parse as JSON`),
      mutation: [
        "parsed = JSON.parse(text);\n  } catch (error) {\n    return { error: `does not parse as JSON",
        "parsed = {};\n  } catch (error) {\n    return { error: `does not parse as JSON",
      ],
    },
    {
      name: "an unknown argument is unusable (exit 2), not ignored",
      files: fixture(),
      args: ["--bogus"],
      holds: (run) => run.exit === 2 && run.err.includes("unknown argument '--bogus'"),
      mutation: ["process.exit(2);", "process.exit(0);"],
    },
    {
      name: "a root that is not a git work tree is unusable (exit 2), not clean",
      files: {},
      root: "plain",
      holds: (run) => run.exit === 2 && run.err.includes("git ls-files failed"),
      mutation: ["process.exit(2);", "process.exit(0);"],
    },
  ]);
});

describe("advisory-floor: the committed floor", () => {
  const committed = readFileSync(join(HERE, "..", "advisories.v1.json"), "utf8");
  const parsed = parseFloor(committed);

  test("parses without a defect and carries every required entry", () => {
    expect(parsed.errors).toEqual([]);
    expect(missingRequired(parsed.entries)).toEqual([]);
  });

  test("a copy without one required entry is not accepted", () => {
    const without: FloorEntry[] = parsed.entries.filter((entry) => entry.package !== CORE);
    expect(missingRequired(without)).not.toEqual([]);
  });

  test("every entry names the publisher repository whose advisories it was read from", () => {
    const allowed = new Set(["langchain-ai/langgraphjs", "langchain-ai/langchainjs"]);
    expect(parsed.entries.filter((entry) => !allowed.has(entry.source))).toEqual([]);
    expect(parsed.denied.filter((entry) => !allowed.has(entry.source))).toEqual([]);
  });

  const withCommitted = (lock: Record<string, string>) =>
    fixture({ floor: committed, lock, manifest: DECLARES_GRAPH });
  const gate = (files: Record<string, Entry>) =>
    spawnClean([process.execPath, FLOOR_GATE, `--root=${newRepo(files)}`]);

  test("accepts the graph at the versions published on 2026-10-23", () => {
    const run = gate(withCommitted(HEALTHY));
    expect(run.err).toBe("");
    expect(run.exit).toBe(0);
    expect(run.out).toContain(`${parsed.entries.length} entr(ies) over`);
  });

  test("refuses the graph at versions just under each minimum, naming each package", () => {
    const run = gate(
      withCommitted({ [GRAPH]: "1.4.11", [CORE]: "1.1.7", [CHECKPOINT]: "1.1.3", [SDK]: "1.12.1" }),
    );
    expect(run.exit).toBe(1);
    for (const name of [GRAPH, CORE, CHECKPOINT, SDK]) {
      expect(run.err).toContain(`${name}@`);
    }
  });
});

describe("advisory-floor: the real tree", () => {
  test("the floor gate accepts the repository as it is and says it is vacuous", () => {
    const top = spawnClean(["git", "-C", HERE, "rev-parse", "--show-toplevel"]);
    expect(top.exit).toBe(0);
    const run = spawnClean([process.execPath, FLOOR_GATE, `--root=${top.out.trim()}`]);
    expect(run.err).toBe("");
    expect(run.exit).toBe(0);
    expect(run.out).toMatch(/\d+ entr\(ies\) over \d+ package\(s\)/);
    expect(run.out).toMatch(/vacuous|\d+ entry-by-lock comparison\(s\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// Instrument 1: osv-scanner offline
// ---------------------------------------------------------------------------------------------

const DAY = 86_400_000;
/** A synchronisation date the tests can predict: whole seconds, one day ago. */
const SYNCED = new Date(Math.floor((Date.now() - DAY) / 1000) * 1000);

/** The advisory database as the scanner lays it out under its cache directory. */
function database(modified: Date | null): string {
  const dir = mkdtempSync(join(scratch, "db-"));
  if (modified !== null) {
    const file = join(dir, "osv-scalibr", "npm", "all.zip");
    mkdirSync(join(dir, "osv-scalibr", "npm"), { recursive: true });
    writeFileSync(file, "not a real database");
    utimesSync(file, modified, modified);
  }
  return dir;
}

const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

interface Scanner {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly report?: unknown;
}

const reportOf = (
  packages: Record<string, string>,
  advisories: Record<string, readonly string[]> = {},
) => ({
  results: [
    {
      source: { path: LOCK, type: "lockfile" },
      packages: Object.entries(packages).map(([name, version]) => ({
        package: { name, version, ecosystem: "npm" },
        vulnerabilities: (advisories[name] ?? []).map((id) => ({ id })),
      })),
    },
  ],
});

/**
 * A scanner that answers `--version`, refuses any download flag (exit 98), refuses to run unless it
 * was pointed at the database directory the gate dated (exit 97), then prints what the case says.
 */
function fakeScanner(dbDir: string, options: Scanner): string {
  const stdout = options.stdout ?? JSON.stringify(options.report ?? reportOf(HEALTHY));
  return writeExecutable(
    "osv-scanner",
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "osv-scanner version: fake-1.0"; exit 0; fi',
      'case "$*" in *download*) exit 98;; esac',
      `[ "$OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY" = '${dbDir}' ] || exit 97`,
      `printf '%s' '${stdout}'`,
      `echo '${options.stderr ?? ""}' >&2`,
      `exit ${options.code ?? 0}`,
      "",
    ].join("\n"),
  );
}

const withScanner =
  (options: Scanner, modified: Date | null = daysAgo(1)) =>
  (_repo: string): string[] => {
    const dir = database(modified);
    return [`--db-dir=${dir}`, `--osv-scanner=${fakeScanner(dir, options)}`];
  };

const NO_SCANNER = (_repo: string) => [
  `--db-dir=${database(daysAgo(1))}`,
  "--osv-scanner=/no/such/osv-scanner",
];

describe("advisory-floor: osv-scanner offline, dated database, never a silent zero", () => {
  prove(OSV_GATE, [
    {
      name: "a clean scan prints the scanner version, the offline command, the volume and the database date",
      files: fixture(),
      args: () => {
        const dir = database(SYNCED);
        return [`--db-dir=${dir}`, `--osv-scanner=${fakeScanner(dir, {})}`];
      },
      holds: accepts(
        `advisory database synchronised ${SYNCED.toISOString()} (1.0 day(s) old, limit 7)`,
        "osv-scanner version: fake-1.0",
        "osv-scanner scan source --offline-vulnerabilities --all-packages --format json -L tools/review/bun.lock",
        "4 package(s) examined by the scanner, 0 advisory finding(s)",
        "OSV advisories verified: no advisory found",
      ),
      mutation: ["database.synced.toISOString()", "'unknown'"],
    },
    {
      name: "the examined volume is the scanner's, not a constant",
      files: fixture(),
      args: withScanner({}),
      holds: accepts("4 package(s) examined by the scanner"),
      mutation: [".length} package(s) examined", ".length * 0} package(s) examined"],
    },
    {
      name: "the scanner is pointed at the directory whose date was read",
      files: fixture(),
      args: withScanner({}),
      holds: accepts("OSV advisories verified"),
      mutation: [
        "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: args.dbDir",
        "OSV_SCANNER_UNUSED: args.dbDir",
      ],
    },
    {
      name: "the scan is offline: it never asks the scanner to download a database",
      files: fixture(),
      args: withScanner({}),
      holds: accepts("OSV advisories verified"),
      mutation: ['"--offline-vulnerabilities",', '"--download-offline-databases",'],
    },
  ]);
});

describe("advisory-floor: osv-scanner is unavailable in each way it can be", () => {
  prove(OSV_GATE, [
    {
      name: "no scanner binary is a failure, not a green",
      files: fixture(),
      args: NO_SCANNER,
      holds: refuses(
        "osv-scanner unavailable: '/no/such/osv-scanner' is not an executable on PATH",
      ),
      mutation: ["if (scanner === null) {", "if (false) {"],
    },
    {
      name: "no database file is a failure, not a green",
      files: fixture(),
      args: withScanner({}, null),
      holds: refuses("advisory database absent"),
      mutation: ["modified = statSync(file).mtimeMs;", "modified = Date.now();"],
    },
    {
      name: "a database older than seven days is a failure",
      files: fixture(),
      args: withScanner({}, daysAgo(7.1)),
      holds: refuses("days old: older than 7 days"),
      mutation: ["age > MAX_AGE_MS", "age > MAX_AGE_MS * 2"],
    },
    {
      name: "a database younger than seven days is accepted",
      files: fixture(),
      args: withScanner({}, daysAgo(6.9)),
      holds: accepts("6.9 day(s) old, limit 7"),
      mutation: ["age > MAX_AGE_MS", "age > MAX_AGE_MS / 2"],
    },
    {
      name: "a database dated in the future is a failure",
      files: fixture(),
      args: withScanner({}, new Date(Date.now() + 2 * DAY)),
      holds: refuses("advisory database dated in the future"),
      mutation: ["age < 0", "false"],
    },
    {
      name: "a scanner that exits 127 is a failure that carries its message",
      files: fixture(),
      args: withScanner({ code: 127, stdout: "", stderr: "database is corrupt" }),
      holds: refuses("osv-scanner exited 127: database is corrupt"),
      mutation: ["code !== 0 && code !== 1", "false"],
    },
    {
      name: "a scanner that exits 128 (no package found) is a failure, not a zero",
      files: fixture(),
      args: withScanner({ code: 128, stdout: "", stderr: "no packages found" }),
      holds: refuses("osv-scanner exited 128: no packages found"),
      mutation: ["code !== 0 && code !== 1", "false"],
    },
    {
      name: "a report that does not parse is a failure",
      files: fixture(),
      args: withScanner({ stdout: "not json" }),
      holds: refuses("report does not parse as JSON"),
      mutation: [
        'if ("error" in report) failures.push(report.error);',
        'if ("error" in report) void report;',
      ],
    },
    {
      name: "a report without a results array is a failure",
      files: fixture(),
      args: withScanner({ stdout: "{}" }),
      holds: refuses("report has no results array"),
      mutation: [
        'return { error: "report has no results array" };',
        "return { examined: [], advisories: [] };",
      ],
    },
    {
      name: "a scan of 0 packages is a failure, not a green",
      files: fixture(),
      args: withScanner({ report: { results: [] } }),
      holds: refuses("the scanner examined 0 package(s)"),
      mutation: ["report.examined.length === 0", "false"],
    },
    {
      name: "a package of the family that the scanner did not examine is a failure",
      files: fixture(),
      args: withScanner({ report: reportOf({ [CORE]: "1.3.0" }) }),
      holds: refuses(`${GRAPH}@1.5.2 is in ${LOCK} but the scanner did not examine it`),
      mutation: ["!seen.has(", "false && seen.has("],
    },
  ]);
});

describe("advisory-floor: osv-scanner finds an advisory", () => {
  const found = reportOf(HEALTHY, { [CORE]: ["GHSA-r399-636x-v7f6"] });
  prove(OSV_GATE, [
    {
      name: "an advisory in the report is a failure that names the package and the id",
      files: fixture(),
      args: withScanner({ code: 1, report: found }),
      holds: refuses(`advisory found: ${CORE}@1.3.0: GHSA-r399-636x-v7f6`),
      mutation: [
        "for (const finding of report.advisories) failures.push(",
        "for (const finding of []) failures.push(",
      ],
    },
    {
      name: "an exit 1 whose report lists no advisory is a failure",
      files: fixture(),
      args: withScanner({ code: 1 }),
      holds: refuses("osv-scanner exited 1 but its report lists no advisory"),
      mutation: ["code === 1 && report.advisories.length === 0", "false"],
    },
  ]);
});

describe("advisory-floor: osv-scanner applies by itself, and says when it does not", () => {
  prove(OSV_GATE, [
    {
      name: "with no package of the family declared or resolved it is not applicable, and says so",
      files: fixture({ manifest: DECLARES_NOTHING, lock: { left: "1.0.0" } }),
      args: NO_SCANNER,
      holds: accepts("not applicable", "0 package(s) scanned", "0 in the publisher family"),
      mutation: ["if (failures.length === 0 && !applies) {", "if (false) {"],
    },
    {
      name: "a package declared in the manifest makes it apply",
      files: fixture({ manifest: DECLARES_GRAPH, lock: { left: "1.0.0" } }),
      args: NO_SCANNER,
      holds: refuses("osv-scanner unavailable"),
      mutation: [
        "const applies = declares || resolvedFamily.length > 0;",
        "const applies = resolvedFamily.length > 0;",
      ],
    },
    {
      name: "a package that arrives transitively in the lockfile makes it apply",
      files: fixture({ manifest: DECLARES_NOTHING, lock: HEALTHY }),
      args: NO_SCANNER,
      holds: refuses("osv-scanner unavailable"),
      mutation: [
        "const applies = declares || resolvedFamily.length > 0;",
        "const applies = declares;",
      ],
    },
    {
      name: "a lockfile that is not tracked is a failure even when nothing would apply",
      files: { [MANIFEST]: DECLARES_NOTHING },
      args: NO_SCANNER,
      holds: refuses(`${LOCK}: the lockfile is not a tracked file`),
      mutation: ["!tracked.includes(args.lock)", "false"],
    },
    {
      name: "a lockfile of a format this gate does not read is a failure",
      files: { ...fixture({ manifest: DECLARES_NOTHING }), "tools/review/yarn.lock": "x\n" },
      args: (repo) => [...NO_SCANNER(repo), "--lock=tools/review/yarn.lock"],
      holds: refuses("lockfile format 'yarn.lock' is not read by this gate"),
      mutation: ['if (name !== "bun.lock")', "if (false)"],
    },
    {
      name: "a manifest that is not tracked is a failure",
      files: { [LOCK]: lockOf({ left: "1.0.0" }) },
      args: NO_SCANNER,
      holds: refuses(`${MANIFEST}: the manifest is not a tracked file`),
      mutation: ["!tracked.includes(args.manifest)", "false"],
    },
    {
      name: "a root that is not a git work tree is unusable (exit 2), not clean",
      files: {},
      root: "plain",
      holds: (run) => run.exit === 2 && run.err.includes("git ls-files failed"),
      mutation: ["process.exit(2);", "process.exit(0);"],
    },
  ]);
});

describe("advisory-floor: the osv gate on the real tree", () => {
  test("accepts the repository as it is and says the instrument is not applicable", () => {
    const top = spawnClean(["git", "-C", HERE, "rev-parse", "--show-toplevel"]);
    expect(top.exit).toBe(0);
    const run = spawnClean([process.execPath, OSV_GATE, `--root=${top.out.trim()}`]);
    expect(run.err).toBe("");
    expect(run.exit).toBe(0);
    expect(run.out).toMatch(/not applicable|package\(s\) examined by the scanner/);
  });
});
