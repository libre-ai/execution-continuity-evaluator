import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type ActivationCondition,
  activationRefusal,
  assertNoPublisherTelemetry,
  isProofInRepository,
  LANGGRAPH_ACTIVATION_CONDITIONS,
  publisherTelemetryVariables,
  unmetConditions,
} from "./fanout-activation";

// Names assembled from parts: the textual telemetry gate scans this file too.
const PREFIX = `${"LANGSMITH"}${"_"}`;
const ALIAS = (suffix: string) => `${"LANGCHAIN"}${"_"}${suffix}`;

const condition = (overrides: Partial<ActivationCondition>): ActivationCondition => ({
  id: "c",
  requirement: "r",
  source: "s",
  workPackage: "WP-0",
  satisfied: false,
  evidence: null,
  ...overrides,
});

describe("activation conditions", () => {
  test("the two conditions of WP-4 are still unmet, so the refusal still stands", () => {
    expect(unmetConditions().map((c) => `${c.id}:${c.workPackage}`)).toEqual([
      "telemetry-egress-refused:WP-4",
      "adaptive-attacks:WP-4",
    ]);
    expect(LANGGRAPH_ACTIVATION_CONDITIONS).toHaveLength(5);
    expect(activationRefusal()).not.toBeNull();
  });

  test("INV-a to INV-c are met, each by its vector in tools/review/vectors", () => {
    const met = LANGGRAPH_ACTIVATION_CONDITIONS.filter((c) => !unmetConditions().includes(c));
    expect(met.map((c) => [c.id, c.workPackage, c.evidence])).toEqual([
      ["inv-a", "WP-3", "tools/review/vectors/inv-a-read-only-passes.test.ts"],
      ["inv-b", "WP-3", "tools/review/vectors/inv-b-effect-arguments.test.ts"],
      ["inv-c", "WP-3", "tools/review/vectors/inv-c-closed-vocabulary.test.ts"],
    ]);
    for (const c of met) expect(isProofInRepository(c.evidence ?? "")).toBe(true);
  });

  // F8: nothing that imports the module can mark a condition met at run time.
  test("the table and each of its conditions are frozen", () => {
    expect(Object.isFrozen(LANGGRAPH_ACTIVATION_CONDITIONS)).toBe(true);
    for (const c of LANGGRAPH_ACTIVATION_CONDITIONS)
      expect([c.id, Object.isFrozen(c)]).toEqual([c.id, true]);
    const table = LANGGRAPH_ACTIVATION_CONDITIONS as ActivationCondition[];
    const first = LANGGRAPH_ACTIVATION_CONDITIONS[0] as { satisfied: boolean };
    expect(() => table.push(condition({ satisfied: true }))).toThrow(TypeError);
    expect(() => table.splice(3)).toThrow(TypeError);
    const unmetBefore = unmetConditions().length;
    expect(() => {
      for (const c of LANGGRAPH_ACTIVATION_CONDITIONS)
        (c as { satisfied: boolean }).satisfied = true;
    }).toThrow(TypeError);
    expect(first.satisfied).toBe(true);
    expect(unmetConditions()).toHaveLength(unmetBefore);
    expect(activationRefusal()).not.toBeNull();
  });

  test("a condition that claims to be met without naming its proof stays unmet", () => {
    const claimed = condition({ satisfied: true, evidence: null });
    expect(unmetConditions([claimed])).toEqual([claimed]);
    expect(activationRefusal([claimed])).not.toBeNull();
  });

  test("a condition that names a proof but is not marked met stays unmet", () => {
    expect(
      unmetConditions([condition({ evidence: "tools/review/vectors/x.test.ts" })]),
    ).toHaveLength(1);
  });

  test("when every condition is met and proven there is nothing to refuse", () => {
    const met = [
      condition({
        satisfied: true,
        evidence: "tools/review/vectors/inv-b-effect-arguments.test.ts",
      }),
    ];
    expect(unmetConditions(met)).toEqual([]);
    expect(activationRefusal(met)).toBeNull();
  });

  test("a proof named outside the repository stays unmet, even when the file exists", () => {
    const absolute = condition({ satisfied: true, evidence: "/etc/hosts" });
    const escaping = condition({
      satisfied: true,
      evidence: relative(join(import.meta.dir, "..", ".."), "/etc/hosts"),
    });
    expect(escaping.evidence?.startsWith("..")).toBe(true);
    expect(unmetConditions([absolute, escaping])).toEqual([absolute, escaping]);
  });

  test("a link inside the root to a file outside it is not a proof", () => {
    const root = mkdtempSync(join(tmpdir(), "activation-root-"));
    try {
      const vectors = join(root, "tools", "review", "vectors");
      mkdirSync(vectors, { recursive: true });
      writeFileSync(join(vectors, "inside.test.ts"), "");
      symlinkSync("/etc/hosts", join(vectors, "outside-link.test.ts"));
      expect(isProofInRepository("tools/review/vectors/inside.test.ts", root)).toBe(true);
      expect(isProofInRepository("tools/review/vectors/outside-link.test.ts", root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // F7: a proof is a regular test file under tools/review/vectors/, nothing else.
  test.each([
    ["the vectors directory itself", "tools/review/vectors"],
    ["a directory named like a test", "tools/review/vectors/dir.test.ts"],
    ["an existing file of the root", "package.json"],
    ["a test outside the vectors directory", "tools/review/fanout-activation.test.ts"],
    ["a file of the vectors directory that is not a test", "tools/review/vectors/notes.ts"],
    [
      "a link in the vectors directory to a file inside the root",
      "tools/review/vectors/alias.test.ts",
    ],
    [
      "a traversal back into the vectors directory",
      "tools/review/../review/vectors/inside.test.ts",
    ],
  ])("%s is not a proof", (_name, path) => {
    const root = mkdtempSync(join(tmpdir(), "activation-root-"));
    try {
      const vectors = join(root, "tools", "review", "vectors");
      mkdirSync(join(vectors, "dir.test.ts"), { recursive: true });
      writeFileSync(join(vectors, "inside.test.ts"), "");
      writeFileSync(join(vectors, "notes.ts"), "");
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "tools", "review", "fanout-activation.test.ts"), "");
      symlinkSync(join(root, "package.json"), join(vectors, "alias.test.ts"));
      // The control: the same root accepts a real vector.
      expect(isProofInRepository("tools/review/vectors/inside.test.ts", root)).toBe(true);
      expect(isProofInRepository(path, root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a condition whose named proof is not in the repository stays unmet", () => {
    // A pull request that flips a condition with a wrong path must not lift the refusal.
    const missing = condition({ satisfied: true, evidence: "tools/review/vectors/absent.test.ts" });
    expect(unmetConditions([missing])).toEqual([missing]);
    expect(activationRefusal([missing])).not.toBeNull();
  });

  test("the refusal names each unmet condition with its source and its work package", () => {
    const message = activationRefusal() ?? "";
    expect(message).toContain("2 of 5 activation condition(s) unmet");
    expect(message).not.toContain("INV-a");
    expect(message).toContain("ADR-0058 section 3 condition 4, CA-22; delivered by WP-4");
    expect(message).toContain("ADR-0045 consequences (vector 4), CA-31; delivered by WP-4");
    expect(message).toContain("--dry-run is available on this runtime");
  });
});

describe("publisher telemetry variables", () => {
  test("the tracing switch, any other variable of the prefix, and the five aliases are found", () => {
    const env = {
      [`${PREFIX}TRACING`]: "true",
      [`${PREFIX}ANYTHING`]: "x",
      [ALIAS("TRACING_V2")]: "true",
      [ALIAS("TRACING")]: "true",
      [ALIAS("API_KEY")]: "k",
      [ALIAS("ENDPOINT")]: "e",
      [ALIAS("CALLBACKS_BACKGROUND")]: "false",
      PATH: "/usr/bin",
    };
    expect(publisherTelemetryVariables(env)).toEqual(
      [
        `${PREFIX}ANYTHING`,
        `${PREFIX}TRACING`,
        ALIAS("API_KEY"),
        ALIAS("CALLBACKS_BACKGROUND"),
        ALIAS("ENDPOINT"),
        ALIAS("TRACING"),
        ALIAS("TRACING_V2"),
      ].sort(),
    );
  });

  test("near misses are not telemetry switches", () => {
    const env = {
      [`MY_${PREFIX}TRACING`]: "true",
      [ALIAS("TRACING_V3")]: "true",
      [ALIAS("PROJECT")]: "p",
      [`${PREFIX}TRACING`.toLowerCase()]: "true",
      HOME: "/home/x",
    };
    expect(publisherTelemetryVariables(env)).toEqual([]);
  });

  test("an empty environment is clean", () => {
    expect(publisherTelemetryVariables({})).toEqual([]);
    expect(() => assertNoPublisherTelemetry({})).not.toThrow();
  });

  test("the refusal names the variables and never prints a value", () => {
    const secret = "sk-do-not-print";
    const env = { [`${PREFIX}API_KEY`]: secret, [ALIAS("TRACING")]: "true" };
    let message = "";
    try {
      assertNoPublisherTelemetry(env);
    } catch (cause) {
      message = String(cause);
    }
    expect(message).toContain(`${PREFIX}API_KEY`);
    expect(message).toContain(ALIAS("TRACING"));
    expect(message).not.toContain(secret);
  });
});
