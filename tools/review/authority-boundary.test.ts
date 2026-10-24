import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { reviewVerdictSchema } from "./fanout-core";

// CA-25: the package is not an authority. The verdict contract is the one it
// was before the package, the pieces that define the contract do not know the
// package, and the default path does not load it.

const REVIEW_DIR = import.meta.dir;
const REPO_ROOT = join(REVIEW_DIR, "..", "..");

// SHA-256 of JSON.stringify(reviewVerdictSchema) at the commit the PRD reads
// (5d3275ec) and at the base of this work package: the same value at both.
const VERDICT_SCHEMA_SHA256 = "f66461827687808c943f99dd856275063b26f892ea81b76bfec5cbdd0fdd2ca8";

async function read(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${path} is missing: this test cannot judge it`);
  return file.text();
}

/** `grep -c -i PATTERN FILE`: the number of lines that match. */
function grepCount(text: string, pattern: RegExp): number {
  return text.split("\n").filter((line) => pattern.test(line)).length;
}

function orchestratorSources(): string[] {
  return readdirSync(REVIEW_DIR).filter(
    (name) =>
      /^fanout.*\.ts$/.test(name) && !name.endsWith(".test.ts") && name !== "fanout-fixtures.ts",
  );
}

describe("the verdict contract is the one the package never touched", () => {
  test("reviewVerdictSchema is byte-identical to its form before the package", () => {
    const digest = createHash("sha256").update(JSON.stringify(reviewVerdictSchema)).digest("hex");
    expect(digest).toBe(VERDICT_SCHEMA_SHA256);
    expect(reviewVerdictSchema.$id).toBe("review-verdict.v0.1");
  });

  test("a field added to the schema moves the digest", () => {
    const widened = {
      ...reviewVerdictSchema,
      properties: { ...reviewVerdictSchema.properties, graphState: { type: "object" } },
    };
    const digest = createHash("sha256").update(JSON.stringify(widened)).digest("hex");
    expect(digest).not.toBe(VERDICT_SCHEMA_SHA256);
  });
});

describe("what defines the contract does not mention the package", () => {
  test.each([
    ["tools/review/fanout-core.ts"],
    ["tools/review/plan.example.json"],
    ["tools/review/plan.orchestrator-ca44eb3.json"],
    ["docs/reviews/orchestrator/ca44eb3/events.jsonl"],
  ])("%s", async (path) => {
    const text = await read(join(REPO_ROOT, path));
    expect(text.length).toBeGreaterThan(0);
    expect(grepCount(text, /langgraph/i)).toBe(0);
  });

  test("fanout-core.ts imports nothing from the package family", async () => {
    const text = await read(join(REVIEW_DIR, "fanout-core.ts"));
    expect(grepCount(text, /@langchain|langsmith|zod/i)).toBe(0);
  });
});

describe("the default path does not load the package", () => {
  test("only fanout-graph.ts imports it", async () => {
    const importers: string[] = [];
    for (const name of orchestratorSources()) {
      const text = await read(join(REVIEW_DIR, name));
      if (grepCount(text, /from "@langchain|import\("@langchain|require\("@langchain/) > 0) {
        importers.push(name);
      }
    }
    expect(importers).toEqual(["fanout-graph.ts"]);
  });

  test("fanout.ts reaches the graph driver by a dynamic import, once, and never statically", async () => {
    const text = await read(join(REVIEW_DIR, "fanout.ts"));
    expect(grepCount(text, /^import .*"\.\/fanout-graph"/)).toBe(0);
    expect(grepCount(text, /await import\("\.\/fanout-graph"\)/)).toBe(1);
  });

  test("no other orchestrator source imports the graph driver", async () => {
    for (const name of orchestratorSources()) {
      if (name === "fanout.ts" || name === "fanout-graph.ts") continue;
      const text = await read(join(REVIEW_DIR, name));
      expect(grepCount(text, /(from|import\() ?"\.\/fanout-graph"/)).toBe(0);
    }
  });
});

// The graph driver may use graph structure and nothing that hands control or
// persistence to the package. Words assembled from parts: the persistence
// gates scan this directory for them too (CA-23).
const PERSISTENCE = ["check", "point"].join("");
const FORBIDDEN_IN_GRAPH: [string, RegExp][] = [
  ["a Command, which lets a node pick the next node", /\bCommand\b/],
  ["an interrupt, which suspends for outside input", /\binterrupt\b/],
  ["a persistence layer", new RegExp(`${PERSISTENCE}|Saver|Store\\b`, "i")],
  ["a serializer of the package", /JsonPlus|serde|deserial/i],
  ["a model or chain class", /\bChat[A-Z]|\bRunnable|\bBaseMessage|@langchain\/core/],
  ["a compile option", /\.compile\(\s*\{/],
];

describe("the graph driver keeps the package a structuring tool", () => {
  test.each(FORBIDDEN_IN_GRAPH)("it uses neither %s", async (_what, pattern) => {
    const text = await read(join(REVIEW_DIR, "fanout-graph.ts"));
    expect(grepCount(text, pattern)).toBe(0);
  });

  test("it imports from @langchain/langgraph only", async () => {
    const text = await read(join(REVIEW_DIR, "fanout-graph.ts"));
    const specifiers = [...text.matchAll(/from "(@langchain\/[^"]+)"/g)].map((match) => match[1]);
    expect(specifiers).toEqual(["@langchain/langgraph"]);
  });

  test("no orchestrator source mentions persistence of the package", async () => {
    for (const name of orchestratorSources()) {
      const text = await read(join(REVIEW_DIR, name));
      expect(grepCount(text, new RegExp(PERSISTENCE, "i"))).toBe(0);
    }
  });
});
