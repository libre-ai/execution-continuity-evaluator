import { describe, expect, test } from "bun:test";
import {
  anchorFinding,
  assertReadable,
  canonicalJson,
  closeManifest,
  DEFAULT_REVIEW_RULES,
  type DiffEntry,
  describePatch,
  type FileOutcome,
  formatClosure,
  isSecretPath,
  loadRulesAtBase,
  parseCoverageRequest,
  parseNameStatusZ,
  parsePatchHunks,
  parseReviewRules,
  partitionFindings,
  REVIEW_RULES_PATH,
  type ReviewRules,
  ruleFor,
  type SealedManifest,
  sealManifest,
  selectFiles,
  settleFromCampaign,
} from "./fanout-coverage";

// The coverage manifest and the anchor are what the code guarantees about a
// review, so that only judgement is left to the model: which files were
// reviewed (and the proof each one was), and where a finding points.

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const REVIEWER = { provider: "p", model: "m", thinking: "off" } as const;

function entry(path: string, overrides: Partial<DiffEntry> = {}): DiffEntry {
  return {
    status: "modified",
    path,
    oldPath: null,
    binary: false,
    patchBytes: 10,
    patchSha256: "0".repeat(64),
    ...overrides,
  };
}

function rules(overrides: Partial<ReviewRules> = {}): ReviewRules {
  return { ...DEFAULT_REVIEW_RULES, ...overrides };
}

function seal(entries: readonly DiffEntry[], ruleSet: ReviewRules = rules()): SealedManifest {
  return sealManifest({
    base: BASE,
    head: HEAD,
    selection: selectFiles(entries, ruleSet),
    rules: ruleSet,
    rulesSource: "default",
    reviewer: REVIEWER,
    roles: ["security"],
  });
}

describe("secret paths", () => {
  test.each([
    [".env"],
    ["app/.env"],
    [".env.production"],
    ["deploy/prod.env"],
    ["certs/server.pem"],
    ["certs/server.KEY"],
    ["home/.ssh/id_rsa"],
    ["id_ed25519"],
    [".git-credentials"],
    ["ops/.pgpass"],
    ["credentials"],
    [".aws/credentials"],
    [".netrc"],
    [".npmrc"],
    ["packages/x/.npmrc"],
    [".docker/config.json"],
    ["store/keystore.p12"],
  ])("%s is a secret path", (path) => {
    expect(isSecretPath(path)).toBe(true);
  });

  test.each([
    ["src/credentials.ts"],
    ["docs/env.md"],
    ["id_rsa.pub"],
    ["src/keys.ts"],
    ["config.json"],
    ["environment/README.md"],
  ])("%s is not a secret path", (path) => {
    expect(isSecretPath(path)).toBe(false);
  });

  test("a secret path is refused at every later read, whether or not it is in the diff", () => {
    expect(() => assertReadable(".pgpass")).toThrow(/secret path/);
    expect(() => assertReadable("never/in/the/diff/.netrc")).toThrow(/secret path/);
    expect(() => assertReadable("src/main.ts")).not.toThrow();
  });
});

describe("selectFiles", () => {
  test("a secret file without an extension is excluded and marked unreadable", () => {
    const selection = selectFiles(
      [entry("src/a.ts"), entry("ops/.pgpass"), entry("credentials")],
      rules(),
    );
    expect(selection.selected.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(selection.excluded).toEqual([
      { path: "credentials", reason: "secret_path", rule: null },
      { path: "ops/.pgpass", reason: "secret_path", rule: null },
    ]);
    expect(selection.readDenied).toEqual(["credentials", "ops/.pgpass"]);
  });

  test("a rename from a secret path is a secret too, under both names", () => {
    const selection = selectFiles(
      [entry("config/settings.txt", { status: "renamed", oldPath: ".env" })],
      rules(),
    );
    expect(selection.selected).toEqual([]);
    expect(selection.excluded[0]?.reason).toBe("secret_path");
    expect(selection.readDenied).toEqual([".env", "config/settings.txt"]);
  });

  test("a secret is reported as a secret even when it is also binary", () => {
    const selection = selectFiles([entry("store/keystore.p12", { binary: true })], rules());
    expect(selection.excluded[0]?.reason).toBe("secret_path");
  });

  test("binary, rule and size exclusions each carry their enumerated reason", () => {
    const selection = selectFiles(
      [
        entry("img/logo.png", { binary: true }),
        entry("vendor/lib.js"),
        entry("big/generated.ts", { patchBytes: 2000 }),
        entry("src/kept.ts", { patchBytes: 1000 }),
      ],
      rules({ maxPatchBytes: 1000, exclude: [{ pattern: "vendor/**", note: "third-party" }] }),
    );
    expect(selection.selected.map((file) => file.path)).toEqual(["src/kept.ts"]);
    expect(selection.excluded).toEqual([
      { path: "big/generated.ts", reason: "too_large", rule: null },
      { path: "img/logo.png", reason: "binary", rule: null },
      { path: "vendor/lib.js", reason: "excluded_by_rule", rule: "vendor/**" },
    ]);
    expect(selection.readDenied).toEqual([]);
  });

  test("a path listed twice is refused: the sealed set is a set", () => {
    expect(() => selectFiles([entry("a.ts"), entry("a.ts")], rules())).toThrow(/twice/);
  });

  test("a deleted file is reviewed: removing code is a change", () => {
    const selection = selectFiles([entry("src/guard.ts", { status: "deleted" })], rules());
    expect(selection.selected.map((file) => file.path)).toEqual(["src/guard.ts"]);
  });
});

describe("parseNameStatusZ", () => {
  test("reads statuses, renames and paths that hold spaces or tabs", () => {
    const raw = [
      "M",
      "src/a b.ts",
      "A",
      "new\tfile",
      "D",
      "gone.ts",
      "R087",
      "old.ts",
      "new.ts",
      "",
    ].join("\0");
    expect(parseNameStatusZ(raw)).toEqual([
      { status: "modified", path: "src/a b.ts", oldPath: null },
      { status: "added", path: "new\tfile", oldPath: null },
      { status: "deleted", path: "gone.ts", oldPath: null },
      { status: "renamed", path: "new.ts", oldPath: "old.ts" },
    ]);
  });

  test("an empty diff is an empty list", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });

  test("an unknown status or a truncated record is refused, never skipped", () => {
    expect(() => parseNameStatusZ(["U", "conflict.ts", ""].join("\0"))).toThrow(/status/);
    expect(() => parseNameStatusZ(["R100", "only-old.ts", ""].join("\0"))).toThrow(/truncated/);
  });
});

describe("describePatch", () => {
  test("measures and fingerprints the patch, and sees a binary header", () => {
    const text = describePatch(
      { status: "modified", path: "a.ts", oldPath: null },
      "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-x\n+y\n",
    );
    expect(text.binary).toBe(false);
    expect(text.patchBytes).toBe(43);
    expect(text.patchSha256).toMatch(/^[0-9a-f]{64}$/);
    const binary = describePatch(
      { status: "added", path: "a.png", oldPath: null },
      "diff --git a/a.png b/a.png\nnew file mode 100644\nBinary files /dev/null and b/a.png differ\n",
    );
    expect(binary.binary).toBe(true);
  });

  test("a hunk line that reads like a binary header is content, not a header", () => {
    const patch = "diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+Binary files x and y differ\n";
    expect(describePatch({ status: "added", path: "a.ts", oldPath: null }, patch).binary).toBe(
      false,
    );
  });
});

describe("canonicalJson", () => {
  test("is independent of key order and refuses what JSON cannot carry", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] })).toBe(
      canonicalJson({ a: [2, { c: "x", d: null }], b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/finite/);
  });
});

describe("sealManifest: the review identity", () => {
  const files = [entry("src/a.ts"), entry("src/b.ts")];
  const reference = seal(files).reviewId;

  test("is a SHA-256 independent of the order the diff listed its files", () => {
    expect(reference).toMatch(/^[0-9a-f]{64}$/);
    expect(seal([...files].reverse()).reviewId).toBe(reference);
  });

  test("moves with the base, the head, a file's diff, the rules and the reviewer", () => {
    const variants = [
      sealManifest({ ...sealInput(files), base: "d".repeat(40) }),
      sealManifest({ ...sealInput(files), head: "e".repeat(40) }),
      seal([entry("src/a.ts", { patchSha256: "1".repeat(64) }), entry("src/b.ts")]),
      seal(files, rules({ zones: [{ pattern: "src/**", guidance: "check the guard" }] })),
      sealManifest({ ...sealInput(files), reviewer: { ...REVIEWER, model: "other" } }),
      seal([entry("src/a.ts")]),
    ];
    for (const variant of variants) expect(variant.reviewId).not.toBe(reference);
  });

  function sealInput(entries: readonly DiffEntry[]) {
    return {
      base: BASE,
      head: HEAD,
      selection: selectFiles(entries, rules()),
      rules: rules(),
      rulesSource: "default",
      reviewer: REVIEWER,
      roles: ["security"],
    };
  }
});

describe("closeManifest", () => {
  const sealed = seal([entry("a.ts"), entry("b.ts"), entry("c.ts")]);

  test("is complete only when every selected file is reviewed or reused", () => {
    const outcomes = new Map<string, FileOutcome>([
      ["a.ts", { state: "reviewed" }],
      ["b.ts", { state: "reused" }],
      ["c.ts", { state: "reviewed" }],
    ]);
    const closed = closeManifest(sealed, outcomes, { budgetExhausted: false });
    expect(closed.status).toBe("complete");
    expect(closed.counts).toEqual({
      selected: 3,
      reviewed: 2,
      reused: 1,
      failed: 0,
      failedByClass: {},
    });
  });

  test("an exhausted budget is partial, never a success, and names the unreached files", () => {
    const outcomes = new Map<string, FileOutcome>([["a.ts", { state: "reviewed" }]]);
    const closed = closeManifest(sealed, outcomes, { budgetExhausted: true });
    expect(closed.status).toBe("partial");
    expect(closed.files).toEqual([
      { path: "a.ts", state: "reviewed" },
      { path: "b.ts", state: "failed", failure: "budget_exhausted" },
      { path: "c.ts", state: "failed", failure: "budget_exhausted" },
    ]);
    expect(closed.counts.failedByClass).toEqual({ budget_exhausted: 2 });
  });

  test("an exhausted budget is partial even when every file was settled", () => {
    const outcomes = new Map<string, FileOutcome>(
      ["a.ts", "b.ts", "c.ts"].map((path) => [path, { state: "reviewed" }]),
    );
    expect(closeManifest(sealed, outcomes, { budgetExhausted: true }).status).toBe("partial");
  });

  test("one failed file makes the review partial", () => {
    const outcomes = new Map<string, FileOutcome>([
      ["a.ts", { state: "reviewed" }],
      ["b.ts", { state: "failed", failure: "reviewer_failed" }],
      ["c.ts", { state: "reviewed" }],
    ]);
    const closed = closeManifest(sealed, outcomes, { budgetExhausted: false });
    expect(closed.status).toBe("partial");
    expect(closed.counts.failed).toBe(1);
  });

  test("a file never settled is failed(not_reached), not silently dropped", () => {
    const closed = closeManifest(sealed, new Map(), { budgetExhausted: false });
    expect(closed.status).toBe("partial");
    expect(closed.counts.failedByClass).toEqual({ not_reached: 3 });
  });

  test("an outcome for a path outside the sealed set is refused", () => {
    const outcomes = new Map<string, FileOutcome>([["elsewhere.ts", { state: "reviewed" }]]);
    expect(() => closeManifest(sealed, outcomes, { budgetExhausted: false })).toThrow(/sealed/);
  });

  test("a review with nothing selected is empty, not complete", () => {
    const empty = seal([entry(".env")]);
    expect(closeManifest(empty, new Map(), { budgetExhausted: false }).status).toBe("empty");
  });

  test("the printed closure carries its counters, which sum to the selected set", () => {
    const outcomes = new Map<string, FileOutcome>([
      ["a.ts", { state: "reviewed" }],
      ["b.ts", { state: "failed", failure: "reviewer_failed" }],
    ]);
    const line = formatClosure(closeManifest(sealed, outcomes, { budgetExhausted: false }));
    expect(line).toContain("coverage partial: 3 selected");
    expect(line).toContain("1 reviewed, 0 reused, 2 failed (not_reached 1, reviewer_failed 1)");
    expect(line).toContain("0 excluded");
  });
});

describe("settleFromCampaign", () => {
  const sealed = seal([entry("a.ts"), entry("b.ts")]);

  test("every role passing settles every file reviewed", () => {
    const outcomes = settleFromCampaign(sealed, {
      executed: [{ role: "security", ok: true }],
      skippedRoles: [],
      prior: null,
    });
    expect([...outcomes.values()]).toEqual([{ state: "reviewed" }, { state: "reviewed" }]);
  });

  test("one failed role pass fails every file of the scope it was given", () => {
    const outcomes = settleFromCampaign(sealed, {
      executed: [{ role: "security", ok: false }],
      skippedRoles: [],
      prior: null,
    });
    expect([...outcomes.values()]).toEqual([
      { state: "failed", failure: "reviewer_failed" },
      { state: "failed", failure: "reviewer_failed" },
    ]);
  });

  test("a skipped role is reused only from a complete prior manifest of the same identity", () => {
    const prior = closeManifest(
      sealed,
      new Map<string, FileOutcome>([
        ["a.ts", { state: "reviewed" }],
        ["b.ts", { state: "reviewed" }],
      ]),
      { budgetExhausted: false },
    );
    const reused = settleFromCampaign(sealed, {
      executed: [],
      skippedRoles: ["security"],
      prior,
    });
    expect([...reused.values()]).toEqual([{ state: "reused" }, { state: "reused" }]);

    const otherIdentity = seal([entry("a.ts"), entry("b.ts", { patchSha256: "9".repeat(64) })]);
    const refused = settleFromCampaign(otherIdentity, {
      executed: [],
      skippedRoles: ["security"],
      prior,
    });
    expect([...refused.values()]).toEqual([
      { state: "failed", failure: "prior_unattested" },
      { state: "failed", failure: "prior_unattested" },
    ]);
    expect(
      [
        ...settleFromCampaign(sealed, {
          executed: [],
          skippedRoles: ["security"],
          prior: null,
        }).values(),
      ][0],
    ).toEqual({ state: "failed", failure: "prior_unattested" });
  });
});

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,4 +10,4 @@ function f() {",
  "   const a = 1;",
  "-  if (user.isAdmin) grant();",
  "+  if (user.isAdmin && user.verified) grant();",
  "   return a;",
  "   return a;",
  "@@ -40,2 +40,3 @@",
  "   const tail = 2;",
  "+  log(tail);",
  "   end();",
  "",
].join("\n");

describe("parsePatchHunks", () => {
  test("numbers each line on its side, hunk by hunk", () => {
    const hunks = parsePatchHunks(PATCH);
    expect(hunks.length).toBe(2);
    expect(hunks[0]?.lines.slice(0, 3)).toEqual([
      { kind: "context", text: "  const a = 1;", oldLine: 10, newLine: 10 },
      { kind: "removed", text: "  if (user.isAdmin) grant();", oldLine: 11, newLine: null },
      {
        kind: "added",
        text: "  if (user.isAdmin && user.verified) grant();",
        oldLine: null,
        newLine: 11,
      },
    ]);
    expect(hunks[1]?.lines[1]).toEqual({
      kind: "added",
      text: "  log(tail);",
      oldLine: null,
      newLine: 41,
    });
  });

  test("a malformed hunk header is refused", () => {
    expect(() => parsePatchHunks("@@ -x +1 @@\n+a\n")).toThrow(/hunk header/);
  });
});

describe("anchorFinding", () => {
  const scope = new Set(["src/a.ts"]);
  const patches = new Map([["src/a.ts", PATCH]]);

  test("anchors a quoted excerpt on the new side first", () => {
    expect(
      anchorFinding(
        { path: "src/a.ts", existingCode: "if (user.isAdmin && user.verified) grant();" },
        scope,
        patches,
      ),
    ).toEqual({ anchored: true, path: "src/a.ts", line: 11, endLine: 11, side: "new" });
  });

  test("anchors on the old side, and says so, when only removed code matches", () => {
    expect(
      anchorFinding(
        { path: "src/a.ts", existingCode: "  if (user.isAdmin) grant();\n" },
        scope,
        patches,
      ),
    ).toEqual({ anchored: true, path: "src/a.ts", line: 11, endLine: 11, side: "old" });
  });

  test("a multi-line excerpt anchors to its first and last line", () => {
    expect(
      anchorFinding(
        { path: "src/a.ts", existingCode: "const tail = 2;\nlog(tail);" },
        scope,
        patches,
      ),
    ).toEqual({ anchored: true, path: "src/a.ts", line: 40, endLine: 41, side: "new" });
  });

  test("an excerpt that matches several lines is not anchored", () => {
    expect(anchorFinding({ path: "src/a.ts", existingCode: "return a;" }, scope, patches)).toEqual({
      anchored: false,
      path: "src/a.ts",
      reason: "ambiguous_excerpt",
    });
  });

  test("an excerpt does not match across two hunks", () => {
    expect(
      anchorFinding(
        { path: "src/a.ts", existingCode: "return a;\nconst tail = 2;" },
        scope,
        patches,
      ),
    ).toEqual({ anchored: false, path: "src/a.ts", reason: "excerpt_not_found" });
  });

  test("a path outside the sealed set is not anchored, even if its text would match", () => {
    expect(
      anchorFinding({ path: "src/other.ts", existingCode: "log(tail);" }, scope, patches),
    ).toEqual({ anchored: false, path: "src/other.ts", reason: "path_not_selected" });
  });

  test("an empty excerpt is not anchored", () => {
    expect(anchorFinding({ path: "src/a.ts", existingCode: " \n " }, scope, patches)).toEqual({
      anchored: false,
      path: "src/a.ts",
      reason: "empty_excerpt",
    });
  });
});

describe("partitionFindings", () => {
  test("only anchored findings are publishable; the rest stay traced with their reason", () => {
    const sealed = seal([entry("src/a.ts")]);
    const findings = [
      { path: "src/a.ts", existingCode: "log(tail);", title: "kept" },
      { path: "src/not-in-diff.ts", existingCode: "log(tail);", title: "outside" },
      { path: "src/a.ts", existingCode: "return a;", title: "ambiguous" },
    ];
    const { publishable, withheld } = partitionFindings(
      findings,
      sealed,
      new Map([["src/a.ts", PATCH]]),
    );
    expect(publishable.map((item) => [item.finding.title, item.anchor.line])).toEqual([
      ["kept", 41],
    ]);
    expect(withheld.map((item) => [item.finding.title, item.reason])).toEqual([
      ["outside", "path_not_selected"],
      ["ambiguous", "ambiguous_excerpt"],
    ]);
  });
});

describe("zone rules", () => {
  const zoned = rules({
    zones: [
      { pattern: "docs/**", guidance: "Documentation: it must not lie." },
      { pattern: "**/*.md", guidance: "Any markdown." },
      { pattern: "tools/review/**", guidance: "Review tooling: fail closed." },
    ],
  });

  test("the first matching zone wins", () => {
    expect(ruleFor("docs/a.md", zoned)?.guidance).toBe("Documentation: it must not lie.");
    expect(ruleFor("README.md", zoned)?.guidance).toBe("Any markdown.");
    expect(ruleFor("tools/review/x.ts", zoned)?.pattern).toBe("tools/review/**");
    expect(ruleFor("src/a.ts", zoned)).toBeNull();
  });

  test("the rules document is validated and refused on any unknown or unsafe field", () => {
    const valid = {
      schema: "review-rules.v1",
      maxPatchBytes: 1000,
      exclude: [{ pattern: "vendor/**", note: "third-party" }],
      zones: [{ pattern: "docs/**", guidance: "short" }],
    };
    expect(parseReviewRules(valid)).toEqual({
      maxPatchBytes: 1000,
      exclude: [{ pattern: "vendor/**", note: "third-party" }],
      zones: [{ pattern: "docs/**", guidance: "short" }],
    });
    expect(() => parseReviewRules({ ...valid, schema: "v2" })).toThrow(/schema/);
    expect(() => parseReviewRules({ ...valid, extra: true })).toThrow(/unknown field/);
    expect(() =>
      parseReviewRules({ ...valid, zones: [{ pattern: "../x", guidance: "g" }] }),
    ).toThrow(/pattern/);
    expect(() =>
      parseReviewRules({ ...valid, zones: [{ pattern: "a/**", guidance: "g".repeat(501) }] }),
    ).toThrow(/guidance/);
    expect(() => parseReviewRules({ ...valid, maxPatchBytes: 0 })).toThrow(/maxPatchBytes/);
  });
});

describe("loadRulesAtBase", () => {
  const atBase = JSON.stringify({
    schema: "review-rules.v1",
    maxPatchBytes: 1000,
    exclude: [],
    zones: [{ pattern: "**", guidance: "base rule" }],
  });
  const atHead = JSON.stringify({
    schema: "review-rules.v1",
    maxPatchBytes: 1000,
    exclude: [{ pattern: "**", note: "the author excludes everything" }],
    zones: [],
  });

  test("reads the rules from the base, and never asks for the head", async () => {
    const asked: string[] = [];
    const read = async (revision: string, _path: string) => {
      asked.push(revision);
      return revision === BASE ? atBase : atHead;
    };
    const loaded = await loadRulesAtBase(read, BASE, REVIEW_RULES_PATH);
    expect(loaded.rules.zones[0]?.guidance).toBe("base rule");
    expect(loaded.rules.exclude).toEqual([]);
    expect(loaded.source).toBe(`${REVIEW_RULES_PATH}@${BASE}`);
    expect(asked).toEqual([BASE]);
  });

  test("rules absent at the base fall back to the defaults, and the source says so", async () => {
    const loaded = await loadRulesAtBase(async () => null, BASE, REVIEW_RULES_PATH);
    expect(loaded.rules).toEqual(DEFAULT_REVIEW_RULES);
    expect(loaded.source).toBe(`default (no ${REVIEW_RULES_PATH} at ${BASE})`);
  });

  test("an unreadable or invalid rules file fails, never falls back", async () => {
    const broken = async () => {
      throw new Error("git failed");
    };
    await expect(loadRulesAtBase(broken, BASE, REVIEW_RULES_PATH)).rejects.toThrow(/git failed/);
    await expect(loadRulesAtBase(async () => "{not json", BASE, REVIEW_RULES_PATH)).rejects.toThrow(
      /rules/,
    );
  });

  test("a rules path that is a secret path is refused before any read", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return atBase;
    };
    await expect(loadRulesAtBase(read, BASE, "config/.env")).rejects.toThrow(/secret path/);
    expect(reads).toBe(0);
  });
});

describe("parseCoverageRequest", () => {
  test("a plan without coverage asks for none", () => {
    expect(parseCoverageRequest({ subject: "x" })).toBeNull();
  });

  test("reads the base and the rules path, with the default rules path", () => {
    expect(parseCoverageRequest({ coverage: { base: BASE } })).toEqual({
      base: BASE,
      rulesPath: REVIEW_RULES_PATH,
    });
    expect(parseCoverageRequest({ coverage: { base: BASE, rules: "docs/review.json" } })).toEqual({
      base: BASE,
      rulesPath: "docs/review.json",
    });
  });

  test("refuses a short base, an unsafe or secret rules path, and unknown fields", () => {
    expect(() => parseCoverageRequest({ coverage: { base: "abc" } })).toThrow(/base/);
    expect(() => parseCoverageRequest({ coverage: { base: BASE, rules: "../x.json" } })).toThrow(
      /rules/,
    );
    expect(() => parseCoverageRequest({ coverage: { base: BASE, rules: ".env" } })).toThrow(
      /secret path/,
    );
    expect(() => parseCoverageRequest({ coverage: { base: BASE, extra: 1 } })).toThrow(
      /unknown field/,
    );
  });
});
