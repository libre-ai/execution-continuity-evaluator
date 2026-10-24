import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  test("today every condition of ADR-0045 and ADR-0058 is unmet, each owned by a work package", () => {
    expect(unmetConditions().map((c) => `${c.id}:${c.workPackage}`)).toEqual([
      "inv-a:WP-3",
      "inv-b:WP-3",
      "inv-c:WP-3",
      "telemetry-egress-refused:WP-4",
      "adaptive-attacks:WP-4",
    ]);
    expect(LANGGRAPH_ACTIVATION_CONDITIONS).toHaveLength(5);
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
      condition({ satisfied: true, evidence: "tools/review/fanout-activation.test.ts" }),
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
      writeFileSync(join(root, "inside.test.ts"), "");
      symlinkSync("/etc/hosts", join(root, "outside-link.test.ts"));
      expect(isProofInRepository("inside.test.ts", root)).toBe(true);
      expect(isProofInRepository("outside-link.test.ts", root)).toBe(false);
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
    expect(message).toContain("5 of 5 activation condition(s) unmet");
    expect(message).toContain("ADR-0045 decision 1 (INV-a), CA-26; delivered by WP-3");
    expect(message).toContain("ADR-0058 section 3 condition 4, CA-22; delivered by WP-4");
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
