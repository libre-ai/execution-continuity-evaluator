// Proof of CA-23, test `persistence-packages`: the gate refuses the publisher's persistence
// packages by name in every tracked manifest and lockfile, counts a reference once, prints the
// volume it examined, and fails closed. Method and harness: harness.ts.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  accepts,
  type Case,
  HERE,
  prove,
  refuses,
  rmFile,
  spawnClean,
  writeEntry,
} from "./harness";

const GATE = join(HERE, "check-langgraph-persistence.ts");

const GRAPH = "@langchain/langgraph";
const CHECKPOINT = "@langchain/langgraph-checkpoint";

const manifest = (dependencies: Record<string, string>) =>
  `${JSON.stringify({ name: "consumer", dependencies }, null, 2)}\n`;

function bunLock(packages: Record<string, string>): string {
  const lines = Object.entries(packages).map(
    ([key, spec]) =>
      `    ${JSON.stringify(key)}: [${JSON.stringify(spec)}, "", {}, "sha512-AAAA"],`,
  );
  return `{\n  "lockfileVersion": 2,\n  "workspaces": { "": { "name": "x" } },\n  "packages": {\n${lines.join("\n")}\n  },\n}\n`;
}

const CLEAN_MANIFEST = manifest({ [GRAPH]: "1.5.2" });
const CLEAN_BUN_LOCK = bunLock({ [GRAPH]: `${GRAPH}@1.5.2`, [CHECKPOINT]: `${CHECKPOINT}@1.2.1` });

const BACKENDS = ["postgres", "redis", "mongodb", "sqlite"];
const REFUSED_REGEX_MUTATION: readonly [string, string] = [
  "langgraph-checkpoint-[a-z0-9]",
  "langgraph-nothing-[a-z0-9]",
];

describe("persistence-packages: refuses the publisher persistence packages", () => {
  prove(GATE, [
    ...BACKENDS.map(
      (backend): Case => ({
        name: `${CHECKPOINT}-${backend} in a manifest`,
        files: {
          "package.json": manifest({ [GRAPH]: "1.5.2", [`${CHECKPOINT}-${backend}`]: "1.0.12" }),
          "bun.lock": CLEAN_BUN_LOCK,
        },
        holds: refuses(new RegExp(`package\\.json:\\d+: ${CHECKPOINT}-${backend}`)),
        mutation: REFUSED_REGEX_MUTATION,
      }),
    ),
    {
      name: "a backend published later under the same prefix",
      files: {
        "package.json": manifest({ [`${CHECKPOINT}-dynamodb`]: "1.0.0" }),
        "bun.lock": CLEAN_BUN_LOCK,
      },
      holds: refuses(`${CHECKPOINT}-dynamodb`),
      mutation: REFUSED_REGEX_MUTATION,
    },
    {
      name: "an alias that installs a persistence package under another name",
      files: {
        "package.json": manifest({ store: `npm:${CHECKPOINT}-postgres@1.0.6` }),
        "bun.lock": CLEAN_BUN_LOCK,
      },
      holds: refuses(`package.json:4: ${CHECKPOINT}-postgres`),
      mutation: REFUSED_REGEX_MUTATION,
    },
    {
      name: "the transitive base package without a suffix stays admitted",
      files: { "package.json": CLEAN_MANIFEST, "bun.lock": CLEAN_BUN_LOCK },
      holds: accepts("0 refused package reference(s)"),
      mutation: [
        "langgraph-checkpoint-[a-z0-9][a-z0-9._-]*",
        "langgraph-checkpoint(?:-[a-z0-9][a-z0-9._-]*)?",
      ],
    },
    ...(
      [
        [
          "bun.lock",
          bunLock({ [`${CHECKPOINT}-postgres`]: `${CHECKPOINT}-postgres@1.0.5` }),
          '"bun.lock",',
        ],
        [
          "package-lock.json",
          `{"lockfileVersion":3,"packages":{"node_modules/${CHECKPOINT}-redis":{"version":"1.0.1"}}}\n`,
          '"package-lock.json",',
        ],
        [
          "npm-shrinkwrap.json",
          `{"lockfileVersion":3,"packages":{"node_modules/${CHECKPOINT}-sqlite":{"version":"1.0.1"}}}\n`,
          '"npm-shrinkwrap.json",',
        ],
        [
          "pnpm-lock.yaml",
          `packages:\n  /${CHECKPOINT}-mongodb@1.5.0:\n    resolution: {}\n`,
          '"pnpm-lock.yaml",',
        ],
        ["yarn.lock", `"${CHECKPOINT}-postgres@^1.0.5":\n  version "1.0.5"\n`, '"yarn.lock",'],
        ["bun.lockb", Buffer.from(`\0\0${CHECKPOINT}-postgres\0`), '"bun.lockb",'],
      ] as const
    ).map(
      ([file, content, token]): Case => ({
        name: `a persistence package in ${file} only`,
        // Another lockfile keeps the lockfile count above zero when the mutant stops reading `file`.
        files: {
          "package.json": CLEAN_MANIFEST,
          ...(file === "bun.lock" ? {} : { "bun.lock": CLEAN_BUN_LOCK }),
          [file]: content,
        },
        holds: refuses(new RegExp(`${file.replace(".", "\\.")}:\\d+: ${CHECKPOINT}-`)),
        mutation: [token, `"unread-${file}",`],
      }),
    ),
    {
      name: "a persistence package in a nested workspace manifest",
      files: {
        "package.json": CLEAN_MANIFEST,
        "bun.lock": CLEAN_BUN_LOCK,
        "packages/worker/package.json": manifest({ [`${CHECKPOINT}-redis`]: "1.0.12" }),
      },
      holds: refuses(`packages/worker/package.json:4: ${CHECKPOINT}-redis`),
      mutation: ["const name = basename(path);", "const name = path;"],
    },
  ]);
});

describe("persistence-packages: a reference is counted once", () => {
  // The template counted `package.json:4` below twice (the key, then the alias target): a volume
  // printed as a count must not double.
  const aliased = `{\n  "dependencies": {\n    "${CHECKPOINT}-redis": "npm:${CHECKPOINT}-redis@1.0.12"\n  }\n}\n`;
  prove(GATE, [
    {
      name: "a name written twice on one line is one reference",
      files: { "package.json": aliased, "bun.lock": CLEAN_BUN_LOCK },
      holds: (run) =>
        refuses(`refused package package.json:3: ${CHECKPOINT}-redis`)(run) &&
        run.out.includes("1 refused package reference(s)") &&
        run.err.split("\n").filter((line) => line.includes("refused package ")).length === 1,
      mutation: ["[...new Set(names)]", "names"],
    },
    {
      name: "two different packages on one line are two references",
      files: {
        "package.json": `{"dependencies":{"a":"npm:${CHECKPOINT}-redis@1","b":"npm:${CHECKPOINT}-postgres@1"}}\n`,
        "bun.lock": CLEAN_BUN_LOCK,
      },
      holds: (run) => run.exit === 1 && run.out.includes("2 refused package reference(s)"),
      mutation: ["[...new Set(names)]", "names.slice(0, 1)"],
    },
    {
      name: "the same package on two lines is two references",
      files: {
        "package.json": manifest({ [`${CHECKPOINT}-redis`]: "1.0.12" }),
        "bun.lock": bunLock({ [`${CHECKPOINT}-redis`]: `${CHECKPOINT}-redis@1.0.12` }),
      },
      holds: (run) => run.exit === 1 && run.out.includes("2 refused package reference(s)"),
      mutation: ["findings.push({ line: index + 1, name });", "void name;"],
    },
  ]);
});

describe("persistence-packages: counts and fails closed", () => {
  prove(GATE, [
    {
      name: "the counters sum to the tracked files (out of scope)",
      files: { "package.json": CLEAN_MANIFEST, "bun.lock": CLEAN_BUN_LOCK, "README.md": "x\n" },
      holds: accepts(
        "3 tracked file(s): 1 manifest(s) and 1 lockfile(s) read, 1 out of scope, 0 unreadable",
      ),
      mutation: ["outOfScope += 1;", "outOfScope += 0;"],
    },
    {
      name: "the counters sum to the tracked files (manifests)",
      files: { "package.json": CLEAN_MANIFEST, "bun.lock": CLEAN_BUN_LOCK },
      holds: accepts("1 manifest(s) and 1 lockfile(s) read"),
      mutation: ["manifests += 1;", "manifests += 0;"],
    },
    {
      name: "the counters sum to the tracked files (lockfiles)",
      files: { "package.json": CLEAN_MANIFEST, "bun.lock": CLEAN_BUN_LOCK },
      holds: accepts("1 manifest(s) and 1 lockfile(s) read"),
      mutation: ["lockfiles += 1;", "lockfiles += 0;"],
    },
    {
      name: "a repository with no manifest is a failure, not a zero",
      files: { "bun.lock": CLEAN_BUN_LOCK },
      holds: refuses("read 0 manifest(s)"),
      mutation: ["result.manifests === 0", "false"],
    },
    {
      name: "a repository with no lockfile is a failure, not a zero",
      files: { "package.json": CLEAN_MANIFEST },
      holds: refuses("read 0 lockfile(s)"),
      mutation: ["result.lockfiles === 0", "false"],
    },
    {
      name: "a tracked manifest that cannot be read is a failure",
      files: {
        "package.json": CLEAN_MANIFEST,
        "bun.lock": CLEAN_BUN_LOCK,
        "packages/a/package.json": "{}\n",
      },
      prepare: (repo) => rmFile(repo, "packages/a/package.json"),
      holds: refuses("packages/a/package.json (unreadable)"),
      mutation: ["of result.unreadable)", "of [])"],
    },
    {
      name: "a lockfile behind a symlink is a failure, not read as clean",
      files: {
        "package.json": CLEAN_MANIFEST,
        "real.lock": "{}\n",
        "bun.lock": { link: "real.lock" },
      },
      holds: refuses("bun.lock (not a regular file)"),
      mutation: ["!lstatSync(absolute).isFile()", "false"],
    },
    {
      name: "an untracked manifest is not examined and not counted",
      files: { "package.json": CLEAN_MANIFEST, "bun.lock": CLEAN_BUN_LOCK },
      prepare: (repo) =>
        writeEntry(repo, "packages/b/package.json", manifest({ [`${CHECKPOINT}-postgres`]: "1" })),
      holds: accepts("2 tracked file(s): 1 manifest(s) and 1 lockfile(s) read"),
      mutation: ['"ls-files", "-z"', '"ls-files", "-z", "--others"'],
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

describe("persistence-packages: the real tree", () => {
  test("the gate accepts the repository as it is and prints the manifests and lockfiles it read", () => {
    const top = spawnClean(["git", "-C", HERE, "rev-parse", "--show-toplevel"]);
    expect(top.exit).toBe(0);
    const run = spawnClean([process.execPath, GATE, `--root=${top.out.trim()}`]);
    expect(run.err).toBe("");
    expect(run.exit).toBe(0);
    expect(run.out).toMatch(
      /\d+ tracked file\(s\): [1-9]\d* manifest\(s\) and [1-9]\d* lockfile\(s\) read, \d+ out of scope, 0 unreadable; 0 refused/,
    );
  });
});
