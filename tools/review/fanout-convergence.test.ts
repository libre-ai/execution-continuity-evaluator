import { describe, expect, test } from "bun:test";
import {
  type Ballot,
  classifySeverity,
  compareRounds,
  DEFAULT_CONVERGENCE_POLICY,
  filterByVote,
  findingIdentity,
  normalizeExcerpt,
  parseConvergencePolicy,
  planNextRound,
  selectToPost,
  tallyVotes,
} from "./fanout-convergence";
import { anchorFinding } from "./fanout-coverage";

// Filtering, severity and convergence over review rounds. The vote decides
// which findings are PUBLISHED; it is not a judge that gates a pass or a merge.

const finding = (path: string, category: string, existingCode: string) => ({
  path,
  category,
  existingCode,
});

describe("finding identity", () => {
  test("is (path, category, excerpt with whitespace folded), whatever the line", () => {
    const a = finding("src/a.ts", "auth", "if (user.isAdmin)\n    grant();");
    const b = finding("src/a.ts", "auth", "  if (user.isAdmin) grant();  ");
    expect(normalizeExcerpt(a.existingCode)).toBe("if (user.isAdmin) grant();");
    expect(findingIdentity(a)).toBe(findingIdentity(b));
  });

  test("changes with the path, the category or the code", () => {
    const base = findingIdentity(finding("src/a.ts", "auth", "grant();"));
    expect(findingIdentity(finding("src/b.ts", "auth", "grant();"))).not.toBe(base);
    expect(findingIdentity(finding("src/a.ts", "perf", "grant();"))).not.toBe(base);
    expect(findingIdentity(finding("src/a.ts", "auth", "deny();"))).not.toBe(base);
  });

  test("cannot be forged by moving text between fields", () => {
    expect(findingIdentity(finding("a", "b c", "d"))).not.toBe(
      findingIdentity(finding("a b", "c", "d")),
    );
  });
});

describe("compareRounds", () => {
  const kept = finding("src/a.ts", "auth", "grant();");
  const fixed = finding("src/b.ts", "auth", "skip();");
  const unseen = finding("src/c.ts", "perf", "loop();");
  const fresh = finding("src/a.ts", "perf", "sleep(1);");

  test("new, persisting, resolved, and not_reviewed for a file the round did not review", () => {
    const compared = compareRounds(
      [kept, fixed, unseen],
      [{ ...kept, existingCode: "  grant();" }, fresh],
      new Set(["src/a.ts", "src/b.ts"]),
    );
    expect(compared.map((item) => [item.finding.path, item.status])).toEqual([
      ["src/a.ts", "persisting"],
      ["src/a.ts", "new"],
      ["src/b.ts", "resolved"],
      ["src/c.ts", "not_reviewed"],
    ]);
  });

  test("a finding absent from a round that did not review its file is never resolved", () => {
    const compared = compareRounds([fixed], [], new Set());
    expect(compared).toEqual([
      { finding: fixed, identity: findingIdentity(fixed), status: "not_reviewed" },
    ]);
  });

  test("a finding reported twice in one round counts once", () => {
    expect(compareRounds([], [fresh, { ...fresh }], new Set(["src/a.ts"])).length).toBe(1);
  });
});

describe("tallyVotes", () => {
  const voters = ["mistral", "qwen"];
  const real = (voter: string): Ballot => ({ voter, judgement: "real" });

  test("the default policy is two of two: the agreement rule of the trust bench", () => {
    expect(DEFAULT_CONVERGENCE_POLICY.vote).toEqual({ k: 2, n: 2 });
    expect(DEFAULT_CONVERGENCE_POLICY.maxRounds).toBe(3);
  });

  test("publishable when at least k distinct declared voters judge it real", () => {
    const outcome = tallyVotes([real("mistral"), real("qwen")], voters, { k: 2, n: 2 });
    expect(outcome.publishable).toBe(true);
    expect(outcome.real).toBe(2);
    expect(outcome.degraded).toBe(false);
  });

  test("one voter saying not real withholds it under two of two", () => {
    const outcome = tallyVotes(
      [real("mistral"), { voter: "qwen", judgement: "not_real" }],
      voters,
      { k: 2, n: 2 },
    );
    expect(outcome.publishable).toBe(false);
    expect(outcome.notReal).toBe(1);
  });

  test("a voter that failed is an absent vote, never a yes, and the tally says it is degraded", () => {
    const outcome = tallyVotes(
      [real("mistral"), { voter: "qwen", judgement: "unavailable", failure: "timeout" }],
      voters,
      { k: 2, n: 2 },
    );
    expect(outcome.publishable).toBe(false);
    expect(outcome.real).toBe(1);
    expect(outcome.absent).toEqual(["qwen"]);
    expect(outcome.degraded).toBe(true);
  });

  test("a voter with no ballot at all is absent too", () => {
    const outcome = tallyVotes([real("mistral")], voters, { k: 1, n: 2 });
    expect(outcome.publishable).toBe(true);
    expect(outcome.absent).toEqual(["qwen"]);
    expect(outcome.degraded).toBe(true);
  });

  test("a second ballot of the same voter and an undeclared voter do not count, and are traced", () => {
    const outcome = tallyVotes([real("mistral"), real("mistral"), real("intruder")], voters, {
      k: 2,
      n: 2,
    });
    expect(outcome.publishable).toBe(false);
    expect(outcome.real).toBe(1);
    expect(outcome.ignored).toEqual([
      { voter: "mistral", reason: "duplicate_ballot" },
      { voter: "intruder", reason: "undeclared_voter" },
    ]);
  });

  test("the declared voters must be n distinct names", () => {
    expect(() => tallyVotes([], ["a"], { k: 1, n: 2 })).toThrow(/voters/);
    expect(() => tallyVotes([], ["a", "a"], { k: 1, n: 2 })).toThrow(/voters/);
  });
});

describe("filterByVote", () => {
  test("publishes what the vote accepts and keeps every withheld finding with its ballots", () => {
    const accepted = finding("src/a.ts", "auth", "grant();");
    const rejected = finding("src/a.ts", "style", "x = 1;");
    const ballots = new Map<string, Ballot[]>([
      [
        findingIdentity(accepted),
        [
          { voter: "a", judgement: "real" },
          { voter: "b", judgement: "real" },
        ],
      ],
      [findingIdentity(rejected), [{ voter: "a", judgement: "real" }]],
    ]);
    const { published, withheld } = filterByVote([accepted, rejected], ballots, ["a", "b"], {
      k: 2,
      n: 2,
    });
    expect(published.map((item) => item.finding)).toEqual([accepted]);
    expect(withheld.map((item) => [item.finding, item.outcome.real, item.outcome.absent])).toEqual([
      [rejected, 1, ["b"]],
    ]);
  });
});

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "@@ -1,4 +1,4 @@",
  " const legacy = eval(input);",
  "-check(user);",
  "+grant(user);",
  " return legacy;",
  " end();",
  "",
].join("\n");
const scope = new Set(["src/a.ts"]);
const patches = new Map([["src/a.ts", PATCH]]);

function anchored(existingCode: string) {
  const anchor = anchorFinding({ path: "src/a.ts", existingCode }, scope, patches);
  if (!anchor.anchored) throw new Error(`fixture excerpt not anchored: ${anchor.reason}`);
  return anchor;
}

describe("classifySeverity", () => {
  test("a finding on an added line keeps the severity the reviewer proposed", () => {
    expect(classifySeverity("important", anchored("grant(user);"), PATCH)).toBe("important");
    expect(classifySeverity("nit", anchored("grant(user);"), PATCH)).toBe("nit");
  });

  test("a finding on a line the diff did not change is pre_existing, whatever was proposed", () => {
    expect(classifySeverity("important", anchored("const legacy = eval(input);"), PATCH)).toBe(
      "pre_existing",
    );
  });

  test("a finding on a removed line is the change's own: the diff removed it", () => {
    const anchor = anchored("check(user);");
    expect(anchor.side).toBe("old");
    expect(classifySeverity("important", anchor, PATCH)).toBe("important");
  });

  test("an excerpt spanning unchanged and added lines is not pre_existing", () => {
    expect(
      classifySeverity("important", anchored("const legacy = eval(input);\ngrant(user);"), PATCH),
    ).toBe("important");
  });
});

describe("planNextRound", () => {
  const round1 = new Map([
    ["src/a.ts", "1".repeat(64)],
    ["src/b.ts", "2".repeat(64)],
  ]);

  test("the first round reviews every sealed file", () => {
    const next = planNextRound({
      completedRounds: 0,
      previous: null,
      current: round1,
      policy: DEFAULT_CONVERGENCE_POLICY,
    });
    expect(next).toEqual({
      action: "review",
      round: 1,
      files: ["src/a.ts", "src/b.ts"],
      carried: [],
    });
  });

  test("a later round reviews only the files whose diff changed, or that are new", () => {
    const current = new Map([
      ["src/a.ts", "1".repeat(64)],
      ["src/b.ts", "9".repeat(64)],
      ["src/c.ts", "3".repeat(64)],
    ]);
    const next = planNextRound({
      completedRounds: 1,
      previous: round1,
      current,
      policy: DEFAULT_CONVERGENCE_POLICY,
    });
    expect(next).toEqual({
      action: "review",
      round: 2,
      files: ["src/b.ts", "src/c.ts"],
      carried: ["src/a.ts"],
    });
  });

  test("past the cap the answer is to revisit the approach, not another round", () => {
    const next = planNextRound({
      completedRounds: 3,
      previous: round1,
      current: new Map([["src/a.ts", "8".repeat(64)]]),
      policy: DEFAULT_CONVERGENCE_POLICY,
    });
    expect(next.action).toBe("revisit_approach");
    expect(next.round).toBe(4);
  });

  test("the cap comes from the policy", () => {
    const policy = parseConvergencePolicy({
      schema: "review-convergence.v1",
      vote: { k: 1, n: 1 },
      maxRounds: 1,
    });
    expect(
      planNextRound({ completedRounds: 1, previous: round1, current: round1, policy }).action,
    ).toBe("revisit_approach");
  });

  test("a later round where no diff changed has nothing to review", () => {
    expect(
      planNextRound({
        completedRounds: 1,
        previous: round1,
        current: round1,
        policy: DEFAULT_CONVERGENCE_POLICY,
      }),
    ).toEqual({
      action: "nothing_changed",
      round: 2,
      files: [],
      carried: ["src/a.ts", "src/b.ts"],
    });
  });
});

describe("selectToPost", () => {
  test("posts new and persisting findings once, never a finding already posted", () => {
    const posted = finding("src/a.ts", "auth", "grant();");
    const fresh = finding("src/a.ts", "perf", "sleep(1);");
    const gone = finding("src/b.ts", "auth", "skip();");
    const compared = compareRounds(
      [posted, gone],
      [posted, fresh],
      new Set(["src/a.ts", "src/b.ts"]),
    );
    const { post, suppressed } = selectToPost(compared, new Set([findingIdentity(posted)]));
    expect(post.map((item) => item.finding)).toEqual([fresh]);
    expect(suppressed.map((item) => [item.finding, item.reason])).toEqual([
      [posted, "already_posted"],
    ]);
  });
});

describe("parseConvergencePolicy", () => {
  test("reads k, n and the cap, and refuses an impossible vote or cap", () => {
    expect(
      parseConvergencePolicy({
        schema: "review-convergence.v1",
        vote: { k: 2, n: 3 },
        maxRounds: 4,
      }),
    ).toEqual({ vote: { k: 2, n: 3 }, maxRounds: 4 });
    const bad = [
      { schema: "review-convergence.v1", vote: { k: 3, n: 2 }, maxRounds: 3 },
      { schema: "review-convergence.v1", vote: { k: 0, n: 2 }, maxRounds: 3 },
      { schema: "review-convergence.v1", vote: { k: 1, n: 2 }, maxRounds: 0 },
      { schema: "review-convergence.v1", vote: { k: 1.5, n: 2 }, maxRounds: 3 },
      { schema: "other", vote: { k: 1, n: 2 }, maxRounds: 3 },
      { schema: "review-convergence.v1", vote: { k: 1, n: 2 }, maxRounds: 3, extra: 1 },
    ];
    for (const raw of bad) expect(() => parseConvergencePolicy(raw)).toThrow(/convergence/);
  });
});
