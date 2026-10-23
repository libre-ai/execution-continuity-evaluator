// Proof of CA-21, test `telemetry-variables`: the gate refuses the telemetry switch of the
// publisher in any tracked file, counts what it swept, and fails closed. Method and harness:
// harness.ts. The names the gate refuses are assembled from parts here too, so that this file is
// itself swept without being refused.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  accepts,
  type Case,
  type Entry,
  HERE,
  prove,
  type Run,
  refuses,
  rmFile,
  spawnClean,
  writeEntry,
} from "./harness";

const GATE = join(HERE, "check-langsmith-env.ts");
const EXEMPTIONS = "tools/review/gates/telemetry-exemptions.v1.json";

const PREFIX = `${"LANGSMITH"}${"_"}`;
const ALIAS = (suffix: string) => `${"LANGCHAIN"}${"_"}${suffix}`;

const exemptions = (paths: readonly string[]) =>
  `${JSON.stringify({
    schema: "telemetry-exemptions.v1",
    exempt: paths.map((path) => ({ path, reason: "a fixture" })),
  })}\n`;

/** A fixture repository: the exemption data is always there, as the real gate requires it. */
const repo = (files: Record<string, Entry>, exempt: readonly string[] = []) => ({
  [EXEMPTIONS]: exemptions(exempt),
  ...files,
});

/** `N tracked file(s): ...` counters: each tracked path lands in exactly one counter. */
function sweepSumsToTracked(run: Run): boolean {
  const match = run.out.match(
    /(\d+) tracked file\(s\): (\d+) scanned, (\d+) exempt by path, (\d+) binary, (\d+) not regular.*?, (\d+) unreadable;/,
  );
  if (match === null) return false;
  const [tracked, ...rest] = match.slice(1).map(Number) as [number, ...number[]];
  return run.exit === 0 && rest.reduce((sum, count) => sum + count, 0) === tracked;
}

const NAME_SOURCE_MUTATION: readonly [string, string] = [`\${PREFIX}[A-Za-z0-9_]*|`, ""];

describe("telemetry-variables: refuses the telemetry switch", () => {
  prove(GATE, [
    {
      name: "a name with the prefix in code",
      files: repo({ "src/client.ts": `const key = process.env.${PREFIX}API_KEY;\n` }),
      holds: refuses(`src/client.ts:1: ${PREFIX}API_KEY`),
      mutation: NAME_SOURCE_MUTATION,
    },
    {
      name: "a name with the prefix in an environment file",
      files: repo({ ".env.production": `# comment\n${PREFIX}TRACING=true\n` }),
      holds: refuses(`.env.production:2: ${PREFIX}TRACING`),
      mutation: NAME_SOURCE_MUTATION,
    },
    {
      name: "a name with the prefix in a workflow",
      files: repo({ ".github/workflows/ci.yml": `env:\n  ${PREFIX}PROJECT: x\n` }),
      holds: refuses(`.github/workflows/ci.yml:2: ${PREFIX}PROJECT`),
      mutation: NAME_SOURCE_MUTATION,
    },
    {
      name: "a name with the prefix in a configuration file",
      files: repo({ "config/app.toml": `[env]\n${PREFIX}ENDPOINT = "x"\n` }),
      holds: refuses(`config/app.toml:2: ${PREFIX}ENDPOINT`),
      mutation: NAME_SOURCE_MUTATION,
    },
    {
      name: "a name with the prefix in a file without extension",
      files: repo({ Dockerfile: `ENV ${PREFIX}TRACING=true\n` }),
      holds: refuses(`Dockerfile:1: ${PREFIX}TRACING`),
      mutation: NAME_SOURCE_MUTATION,
    },
    {
      name: "the bare prefix",
      files: repo({ "src/a.ts": `// ${PREFIX}\n` }),
      holds: refuses(`src/a.ts:1: ${PREFIX}`),
      mutation: NAME_SOURCE_MUTATION,
    },
    ...[
      ["TRACING_V2", '"TRACING_V2"'],
      ["TRACING", '"TRACING"'],
      ["API_KEY", '"API_KEY"'],
      ["ENDPOINT", '"ENDPOINT"'],
      ["CALLBACKS_BACKGROUND", '"CALLBACKS_BACKGROUND"'],
    ].map(
      ([suffix, token]): Case => ({
        name: `the alias ${ALIAS(suffix as string)}`,
        files: repo({ ".env.local": `${ALIAS(suffix as string)}=1\n` }),
        holds: refuses(`.env.local:1: ${ALIAS(suffix as string)}`),
        mutation: [token as string, '"NO_SUCH_ALIAS"'],
      }),
    ),
    {
      name: "prose that is not exempt is swept: CA-21 exempts two files, not prose",
      files: repo({ "docs/notes.md": `Never set ${PREFIX}TRACING.\n`, "a.ts": "export {};\n" }),
      holds: refuses(`docs/notes.md:1: ${PREFIX}TRACING`),
      mutation: ["exemptPaths.has(path)", "true"],
    },
  ]);
});

describe("telemetry-variables: the exemption is by path, read, counted and printed", () => {
  prove(GATE, [
    {
      name: "an exempt file may hold the names, and the gate prints how many",
      files: repo(
        { "docs/spec.md": `${PREFIX}A and ${ALIAS("TRACING")}\n`, "a.ts": "export {};\n" },
        ["docs/spec.md"],
      ),
      holds: accepts("1 exempt by path", "docs/spec.md (2 name(s) inside)", "0 refused name(s)"),
      mutation: ["if (exemptPaths.has(path)) {", "if (false) {"],
    },
    {
      name: "the exemption counts the names inside, not the files",
      files: repo({ "docs/spec.md": `${PREFIX}A\n${PREFIX}B\n${PREFIX}C\n`, "a.ts": "x\n" }, [
        "docs/spec.md",
      ]),
      holds: accepts("docs/spec.md (3 name(s) inside)"),
      mutation: [
        'scanText(bytes.toString("utf8")).length });\n      continue;',
        "0 });\n      continue;",
      ],
    },
    {
      name: "an exemption does not cover the sibling that shares its name",
      files: repo(
        { "docs/spec.md": `${PREFIX}A\n`, "docs/spec.md.bak": `${PREFIX}B\n`, "a.ts": "x\n" },
        ["docs/spec.md"],
      ),
      holds: refuses(`docs/spec.md.bak:1: ${PREFIX}B`),
      mutation: ["exemptPaths.has(path)", "[...exemptPaths].some((p) => path.startsWith(p))"],
    },
    {
      name: "an exemption that names no tracked file is stale and a failure",
      files: repo({ "a.ts": "export {};\n" }, ["docs/gone.md"]),
      holds: refuses("docs/gone.md: exempt by the data file but not a tracked file"),
      mutation: ["exempt.filter((path) => !trackedSet.has(path))", "[]"],
    },
  ]);
});

describe("telemetry-variables: what it must not refuse, and what it counts", () => {
  prove(GATE, [
    {
      name: "a name that merely contains the prefix is a different variable",
      files: repo({ ".env": `MY_${PREFIX}KEY=1\n`, "a.ts": "export {};\n" }),
      holds: accepts("0 refused name(s)"),
      mutation: ["(?<![A-Za-z0-9_])", ""],
    },
    {
      name: "a name in another letter case is not refused: the match is case-sensitive, the SDK reads the exact form",
      files: repo({ ".env": `${PREFIX.toLowerCase()}tracing=true\n` }),
      holds: accepts("0 refused name(s)"),
      mutation: ['  "g",', '  "gi",'],
    },
    {
      name: "the run declares that a name in another letter case is not seen",
      files: repo({ "a.ts": "export {};\n" }),
      holds: accepts("not seen", "a name in another letter case", "the match is case-sensitive"),
      mutation: ["letter case (the match is case-sensitive: the SDK reads the exact form); ", ""],
    },
    {
      name: "an alias followed by more name characters is a different variable",
      files: repo({ ".env": `${ALIAS("TRACING")}_EXTRA=1\n` }),
      holds: accepts("0 refused name(s)"),
      mutation: ["(?![A-Za-z0-9_])", ""],
    },
    {
      name: "a symlink is counted and named, its target is not followed",
      files: repo({ "a.ts": "export {};\n", "link.ts": { link: "a.ts" } }),
      holds: accepts("1 not regular: link.ts"),
      mutation: ["if (!regular) {", "if (false) {"],
    },
    {
      name: "a binary file is counted and not scanned",
      files: repo({ "a.ts": "export {};\n", "blob.bin": Buffer.from(`\0${PREFIX}A=1`) }),
      holds: accepts("1 binary", "0 refused name(s)"),
      mutation: ["if (isBinary) {", "if (false) {"],
    },
    {
      name: "an untracked file is not examined and not counted",
      files: repo({ "a.ts": "export {};\n" }),
      prepare: (path) => writeEntry(path, "untracked.env", `${PREFIX}A=1\n`),
      holds: accepts("2 tracked file(s): 2 scanned"),
      mutation: ['"ls-files", "-z"', '"ls-files", "-z", "--others"'],
    },
    {
      name: "the counters sum to the tracked files (scanned)",
      files: repo({
        "a.ts": "export {};\n",
        "b.json": "{}\n",
        "README.md": "x\n",
        "link.ts": { link: "a.ts" },
        "blob.bin": Buffer.from("\0\0"),
      }),
      holds: sweepSumsToTracked,
      mutation: ["scanned += 1;", "scanned += 0;"],
    },
    {
      name: "the counters sum to the tracked files (exempt)",
      files: repo({ "a.ts": "export {};\n", "docs/f.md": "x=1\n" }, ["docs/f.md"]),
      holds: sweepSumsToTracked,
      mutation: ["exempted.push({", "[].push({"],
    },
    {
      name: "the counters sum to the tracked files (binary)",
      files: repo({ "a.ts": "export {};\n", "blob.bin": Buffer.from("\0\0") }),
      holds: sweepSumsToTracked,
      mutation: ["binary += 1;", "binary += 0;"],
    },
    {
      name: "the counters sum to the tracked files (not regular)",
      files: repo({ "a.ts": "export {};\n", "link.ts": { link: "a.ts" } }),
      holds: sweepSumsToTracked,
      mutation: ["notRegular.push(path);", "void path;"],
    },
  ]);
});

describe("telemetry-variables: fails closed", () => {
  prove(GATE, [
    {
      name: "a tracked file that cannot be read is a failure, not a zero",
      files: repo({ "a.ts": "export {};\n", "gone.ts": "export {};\n" }),
      prepare: (path) => rmFile(path, "gone.ts"),
      holds: refuses("gone.ts: tracked but unreadable"),
      mutation: ["of result.unreadable)", "of [])"],
    },
    {
      name: "a run that scanned nothing is a failure",
      files: repo({ "docs/only.md": "x\n" }, [EXEMPTIONS, "docs/only.md"]),
      holds: refuses("scanned 0 file(s)"),
      mutation: ["result.scanned === 0", "false"],
    },
    {
      name: "a root that is not a git work tree is unusable (exit 2), not clean",
      files: {},
      root: "plain",
      holds: (run) => run.exit === 2 && run.err.includes("git ls-files failed"),
      mutation: ["process.exit(2);", "process.exit(0);"],
    },
    {
      name: "the line that holds a refused name is never printed",
      files: repo({ ".env": `${PREFIX}API_KEY=lsv2_pt_SECRETVALUE\n` }),
      holds: (run) =>
        refuses(`.env:1: ${PREFIX}API_KEY`)(run) && !(run.out + run.err).includes("SECRETVALUE"),
      mutation: ["name: match[0]", "name: line"],
    },
  ]);
});

describe("telemetry-variables: the exemption data is tracked policy", () => {
  const withData = (data: string): Record<string, Entry> => ({
    [EXEMPTIONS]: data,
    "a.ts": "export {};\n",
  });
  prove(GATE, [
    {
      name: "exemption data that is not a tracked file is not policy",
      files: { "a.ts": "export {};\n" },
      holds: refuses(`${EXEMPTIONS}: the exemption data is not a tracked file`),
      mutation: ["!tracked.includes(args.exemptions)", "false"],
    },
    {
      name: "tracked exemption data that cannot be read is a failure",
      files: repo({ "a.ts": "export {};\n" }),
      prepare: (path) => rmFile(path, EXEMPTIONS),
      holds: refuses(`${EXEMPTIONS}: exemption data unreadable`),
      mutation: [
        'exemptions = parseExemptions(readFileSync(join(args.root, args.exemptions), "utf8"));',
        "exemptions = { exempt: [], errors: [] };",
      ],
    },
    {
      name: "exemption data that does not parse is a failure",
      files: withData("{{{\n"),
      holds: refuses(`${EXEMPTIONS}: does not parse as JSON`),
      mutation: [
        "parsed = JSON.parse(text);",
        'parsed = { schema: "telemetry-exemptions.v1", exempt: [] };',
      ],
    },
    {
      name: "exemption data of another schema is a failure",
      files: withData('{"schema":"other","exempt":[]}\n'),
      holds: refuses("schema must be 'telemetry-exemptions.v1'"),
      mutation: ['parsed.schema !== "telemetry-exemptions.v1"', "false"],
    },
    {
      name: "an unknown key in the exemption data is a failure",
      files: withData('{"schema":"telemetry-exemptions.v1","exempt":[],"extra":1}\n'),
      holds: refuses("unknown key 'extra'"),
      mutation: ['key !== "schema" && key !== "exempt"', "false"],
    },
    ...[
      ["an absolute path", "/etc/passwd"],
      ["a path that climbs out of the root", "../outside.md"],
      ["an empty path", ""],
    ].map(
      ([name, path]): Case => ({
        name: `${name} is not a repository-relative exemption`,
        files: withData(
          `${JSON.stringify({ schema: "telemetry-exemptions.v1", exempt: [{ path, reason: "x" }] })}\n`,
        ),
        holds: refuses("is not a repository-relative path"),
        mutation: [
          'item.path === "" || item.path.startsWith("/") || item.path.split("/").includes("..")',
          "false",
        ],
      }),
    ),
    {
      name: "an exemption without a reason is a failure",
      files: withData(
        `${JSON.stringify({ schema: "telemetry-exemptions.v1", exempt: [{ path: "docs/x.md", reason: "  " }] })}\n`,
      ),
      holds: refuses("'docs/x.md' has an empty reason"),
      mutation: ['item.reason.trim() === ""', "false"],
    },
    {
      name: "the same path exempted twice is a failure",
      files: withData(
        `${JSON.stringify({
          schema: "telemetry-exemptions.v1",
          exempt: [
            { path: "docs/x.md", reason: "a" },
            { path: "docs/x.md", reason: "b" },
          ],
        })}\n`,
      ),
      holds: refuses("'docs/x.md' is already exempt"),
      mutation: ["seen.has(item.path)", "false"],
    },
  ]);
});

describe("telemetry-variables: the committed exemptions and the real tree", () => {
  const committed = readFileSync(join(HERE, "telemetry-exemptions.v1.json"), "utf8");
  const exempted = (text: string) =>
    (JSON.parse(text) as { exempt: { path: string }[] }).exempt.map((item) => item.path).sort();

  test("exempt exactly the two files CA-21 names, and a copy without one does not", () => {
    expect(exempted(committed)).toEqual(["docs/cahier-des-charges.md", "docs/prd.md"]);
    const without = JSON.stringify({
      ...JSON.parse(committed),
      exempt: JSON.parse(committed).exempt.slice(1),
    });
    expect(exempted(without)).not.toEqual(["docs/cahier-des-charges.md", "docs/prd.md"]);
  });

  test("the gate accepts the repository as it is and prints its volume", () => {
    const top = spawnClean(["git", "-C", HERE, "rev-parse", "--show-toplevel"]);
    expect(top.exit).toBe(0);
    const run = spawnClean([process.execPath, GATE, `--root=${top.out.trim()}`]);
    expect(run.err).toBe("");
    expect(run.exit).toBe(0);
    expect(run.out).toMatch(/\d+ tracked file\(s\): \d+ scanned, 2 exempt by path/);
    expect(sweepSumsToTracked(run)).toBe(true);
  });
});
