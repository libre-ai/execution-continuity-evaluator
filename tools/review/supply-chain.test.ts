import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// CA-19: the package enters pinned, locked and aged, and nothing downloads at
// run time. The advisory floor (CA-18) and the persistence refusal (CA-23) are
// WP-1's gates; this file pins what the work package itself adds.

const REVIEW_DIR = import.meta.dir;

// ADR-0058 section 1 admits the graph runtime, its core and its checkpoint
// interface package, and nothing else of the family: not `langchain` (chains,
// prompt templates, loaders), not the publisher's SDKs or telemetry client as
// a direct dependency.
const ADMITTED_FAMILY = [
  "@langchain/core",
  "@langchain/langgraph",
  "@langchain/langgraph-checkpoint",
] as const;
const PEER_OF_FAMILY = ["zod"] as const;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

async function manifest(): Promise<Manifest> {
  return Bun.file(join(REVIEW_DIR, "package.json")).json();
}

function declared(manifestValue: Manifest): Record<string, string> {
  return {
    ...manifestValue.devDependencies,
    ...manifestValue.dependencies,
    ...manifestValue.overrides,
  };
}

describe("manifest", () => {
  test("the package family is declared, each in an exact version", async () => {
    const deps = (await manifest()).dependencies ?? {};
    for (const name of [...ADMITTED_FAMILY, ...PEER_OF_FAMILY]) {
      expect(deps[name], `${name} is declared`).toMatch(EXACT_VERSION);
    }
  });

  test("no range prefix on anything the family brings in", async () => {
    const all = declared(await manifest());
    for (const [name, spec] of Object.entries(all)) {
      if (name.startsWith("@langchain/") || name === "zod" || name === "langsmith") {
        expect(spec, `${name}`).toMatch(EXACT_VERSION);
      }
    }
  });

  test("nothing of the family beyond the admitted packages is a direct dependency", async () => {
    const names = Object.keys(declared(await manifest()));
    const family = names.filter(
      (name) => name.startsWith("@langchain/") || name === "langchain" || name === "langsmith",
    );
    expect(family.sort()).toEqual([...ADMITTED_FAMILY]);
  });
});

describe("lock", () => {
  async function lockText(): Promise<string> {
    return Bun.file(join(REVIEW_DIR, "bun.lock")).text();
  }

  test("every pinned package resolves, in the lock, to the version the manifest pins", async () => {
    const deps = (await manifest()).dependencies ?? {};
    const lock = await lockText();
    for (const name of [...ADMITTED_FAMILY, ...PEER_OF_FAMILY]) {
      const version = deps[name];
      expect(version).toBeDefined();
      // Workspace section: the specifier the manifest declares.
      expect(lock).toContain(`"${name}": "${version}"`);
      // Resolution section: the package at exactly that version.
      expect(lock).toContain(`"${name}": ["${name}@${version}"`);
    }
  });

  test("the lock records an integrity hash for every @langchain package it resolves", async () => {
    const lock = await lockText();
    const resolved = [
      ...lock.matchAll(
        /^ {4}"(@langchain\/[^"]+)": \["[^"]+", "", \{[^\n]*\}, "(sha512-[^"]+)"\]/gm,
      ),
    ];
    expect(resolved.length).toBeGreaterThanOrEqual(ADMITTED_FAMILY.length);
    for (const match of resolved) expect(match[2]).toMatch(/^sha512-/);
  });
});

describe("release-age guard", () => {
  async function bunfig(): Promise<string> {
    return Bun.file(join(REVIEW_DIR, "bunfig.toml")).text();
  }

  test("minimumReleaseAge is three days, stated once", async () => {
    const lines = (await bunfig()).split("\n");
    expect(lines.filter((line) => line === "minimumReleaseAge = 259200")).toHaveLength(1);
  });

  test("no package is excluded from the guard", async () => {
    const lines = (await bunfig()).split("\n");
    expect(lines.filter((line) => line === "minimumReleaseAgeExcludes = []")).toHaveLength(1);
  });
});

describe("no download at run time", () => {
  // The orchestrator spawns git and `pi` and reads local files. A network
  // primitive in its sources would be a download the lock cannot see.
  const NETWORK =
    /\bfetch\(|node:https?|node:net\b|node:dgram|Bun\.connect|Bun\.listen|new WebSocket|XMLHttpRequest|\[\s*"(bun|bunx|npm|npx|pnpm|yarn)"/;

  test("the orchestrator sources use no network primitive and never invoke a package manager", async () => {
    const sources = readdirSync(REVIEW_DIR).filter(
      (name) =>
        /^fanout.*\.ts$/.test(name) && !name.endsWith(".test.ts") && name !== "fanout-fixtures.ts",
    );
    expect(sources).toContain("fanout.ts");
    for (const name of sources) {
      const text = await Bun.file(join(REVIEW_DIR, name)).text();
      expect(
        text.split("\n").filter((line) => NETWORK.test(line)),
        name,
      ).toEqual([]);
    }
  });
});
