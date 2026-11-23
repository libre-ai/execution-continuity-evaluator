import {
  type AnchorResult,
  canonicalJson,
  type PatchLine,
  parsePatchHunks,
  type SealedManifest,
  sha256Hex,
} from "./fanout-coverage";

// Filtering, severity and convergence over review rounds, all pure.
//
//   * a finding has an identity that survives a line shift, so two rounds can
//     be compared: new, persisting, resolved, or not_reviewed — a file the
//     round did not review proves nothing about its findings;
//   * a vote of distinct voters decides which findings are PUBLISHED;
//   * the severity of a finding on a line the diff did not change is
//     pre_existing, whatever the reviewer proposed, so the author is not
//     charged with it;
//   * the number of rounds is capped by this code, a later round re-reviews
//     only the files whose diff changed, and a finding is posted once.
//
// What the vote is NOT. It filters the publication of findings; it is not a
// judge that conditions a pass or a merge (project-governance
// AGENT-REVIEW-PROTOCOL.md, "Reviewer isolation": a second judge may add a
// refusal, never lift one, and its failure counts as a refusal). Nothing here
// lifts a refusal, settles a file of the coverage manifest, or feeds
// `closeManifest`: a withheld finding stays traced with its ballots, and an
// absent vote (a voter that failed) is never a yes — it can make no finding
// publishable, and it can make neither a review complete nor a pass.

// ── Policy ───────────────────────────────────────────────────────────────────

export interface VotePolicy {
  /** Votes "real" required to publish. */
  readonly k: number;
  /** Declared voters. */
  readonly n: number;
}

export interface ConvergencePolicy {
  readonly vote: VotePolicy;
  /** Rounds allowed before the answer becomes "revisit the approach". */
  readonly maxRounds: number;
}

export const CONVERGENCE_POLICY_SCHEMA = "review-convergence.v1";

/**
 * Two of two: the "agreement of both" rule measured by the project-governance
 * trust bench (distribution/evidence/2026-11-16-trust-bench-first-measure.md:
 * 0 false alarms out of 8 healthy cases, against 1 out of 8 for each model
 * alone). Three rounds, then revisit the approach: the cap Anthropic describes
 * for the Claude Code team's own reviews.
 */
export const DEFAULT_CONVERGENCE_POLICY: ConvergencePolicy = {
  vote: { k: 2, n: 2 },
  maxRounds: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

/** Validate a policy document; anything unknown or impossible refuses it whole. */
export function parseConvergencePolicy(raw: unknown): ConvergencePolicy {
  if (!isRecord(raw)) throw new Error("convergence policy: a JSON object is required");
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!["schema", "vote", "maxRounds"].includes(key)) {
      errors.push(`unknown field ${JSON.stringify(key)}`);
    }
  }
  if (raw.schema !== CONVERGENCE_POLICY_SCHEMA) {
    errors.push(`schema must be ${JSON.stringify(CONVERGENCE_POLICY_SCHEMA)}`);
  }
  const vote = isRecord(raw.vote) ? raw.vote : {};
  if (!isPositiveInteger(vote.k) || !isPositiveInteger(vote.n) || vote.k > vote.n) {
    errors.push("vote: integers 1 <= k <= n required");
  }
  if (!isPositiveInteger(raw.maxRounds)) errors.push("maxRounds: positive integer required");
  if (errors.length > 0) throw new Error(`invalid convergence policy: ${errors.join("; ")}`);
  return {
    vote: { k: vote.k as number, n: vote.n as number },
    maxRounds: raw.maxRounds as number,
  };
}

// ── Identity and comparison ──────────────────────────────────────────────────

export interface RoundFinding {
  readonly path: string;
  /** The class of defect, as the reviewer names it. */
  readonly category: string;
  /** Code quoted by the reviewer. */
  readonly existingCode: string;
}

/** Whitespace runs folded to one space, ends trimmed: re-flowed code is the same code. */
export function normalizeExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * (path, category, normalized excerpt), hashed over a canonical array so no
 * text can move between fields and collide. No line number: a finding that
 * shifts with the code above it keeps its identity.
 */
export function findingIdentity(finding: RoundFinding): string {
  return sha256Hex(
    canonicalJson([finding.path, finding.category, normalizeExcerpt(finding.existingCode)]),
  );
}

export type RoundStatus = "new" | "persisting" | "resolved" | "not_reviewed";

export interface ComparedFinding<F extends RoundFinding> {
  readonly finding: F;
  readonly identity: string;
  readonly status: RoundStatus;
}

/**
 * Compare a round with the previous one. The current findings come first, in
 * their order (new or persisting, duplicates counted once); then each previous
 * finding the current round did not report: resolved only if the current
 * round reviewed its file, not_reviewed otherwise.
 */
export function compareRounds<F extends RoundFinding>(
  previous: readonly F[],
  current: readonly F[],
  reviewedNow: ReadonlySet<string>,
): ComparedFinding<F>[] {
  const previousIds = new Set(previous.map(findingIdentity));
  const seen = new Set<string>();
  const compared: ComparedFinding<F>[] = [];
  for (const finding of current) {
    const identity = findingIdentity(finding);
    if (seen.has(identity)) continue;
    seen.add(identity);
    compared.push({ finding, identity, status: previousIds.has(identity) ? "persisting" : "new" });
  }
  for (const finding of previous) {
    const identity = findingIdentity(finding);
    if (seen.has(identity)) continue;
    seen.add(identity);
    compared.push({
      finding,
      identity,
      status: reviewedNow.has(finding.path) ? "resolved" : "not_reviewed",
    });
  }
  return compared;
}

// ── Vote ─────────────────────────────────────────────────────────────────────

export type Ballot =
  | { readonly voter: string; readonly judgement: "real" | "not_real" }
  | { readonly voter: string; readonly judgement: "unavailable"; readonly failure: string };

export interface VoteOutcome {
  readonly publishable: boolean;
  readonly real: number;
  readonly notReal: number;
  /** Declared voters with no usable ballot: failed, or silent. Never counted as yes. */
  readonly absent: readonly string[];
  /** True when any declared voter is absent: the vote was not held in full. */
  readonly degraded: boolean;
  readonly ballots: readonly Ballot[];
  readonly ignored: readonly {
    readonly voter: string;
    readonly reason: "duplicate_ballot" | "undeclared_voter";
  }[];
  readonly policy: VotePolicy;
}

/**
 * Count the ballots of the declared voters. One ballot per voter (the first);
 * a later ballot of the same voter, or a ballot of an undeclared voter, is
 * ignored and traced. Publishable when at least k voters judge it real.
 */
export function tallyVotes(
  ballots: readonly Ballot[],
  voters: readonly string[],
  policy: VotePolicy,
): VoteOutcome {
  if (voters.length !== policy.n || new Set(voters).size !== voters.length) {
    throw new Error(`voters: ${policy.n} distinct declared voter(s) required`);
  }
  const declared = new Set(voters);
  const counted = new Map<string, Ballot>();
  const ignored: { voter: string; reason: "duplicate_ballot" | "undeclared_voter" }[] = [];
  for (const ballot of ballots) {
    if (!declared.has(ballot.voter))
      ignored.push({ voter: ballot.voter, reason: "undeclared_voter" });
    else if (counted.has(ballot.voter)) {
      ignored.push({ voter: ballot.voter, reason: "duplicate_ballot" });
    } else counted.set(ballot.voter, ballot);
  }
  let real = 0;
  let notReal = 0;
  const absent: string[] = [];
  for (const voter of voters) {
    const judgement = counted.get(voter)?.judgement;
    if (judgement === "real") real += 1;
    else if (judgement === "not_real") notReal += 1;
    else absent.push(voter);
  }
  return {
    publishable: real >= policy.k,
    real,
    notReal,
    absent,
    degraded: absent.length > 0,
    ballots: [...ballots],
    ignored,
    policy,
  };
}

export interface VoteFiltered<F extends RoundFinding> {
  readonly published: readonly { readonly finding: F; readonly outcome: VoteOutcome }[];
  /** Never dropped: each withheld finding is kept with the ballots that withheld it. */
  readonly withheld: readonly { readonly finding: F; readonly outcome: VoteOutcome }[];
}

export function filterByVote<F extends RoundFinding>(
  findings: readonly F[],
  ballotsByIdentity: ReadonlyMap<string, readonly Ballot[]>,
  voters: readonly string[],
  policy: VotePolicy,
): VoteFiltered<F> {
  const published: { finding: F; outcome: VoteOutcome }[] = [];
  const withheld: { finding: F; outcome: VoteOutcome }[] = [];
  for (const finding of findings) {
    const outcome = tallyVotes(
      ballotsByIdentity.get(findingIdentity(finding)) ?? [],
      voters,
      policy,
    );
    (outcome.publishable ? published : withheld).push({ finding, outcome });
  }
  return { published, withheld };
}

// ── Severity ─────────────────────────────────────────────────────────────────

export type ProposedSeverity = "important" | "nit";
export type Severity = ProposedSeverity | "pre_existing";

type Anchored = Extract<AnchorResult, { anchored: true }>;

/** The diff lines an anchor covers, on its side. */
function anchoredLines(anchor: Anchored, patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  for (const hunk of parsePatchHunks(patch)) {
    for (const line of hunk.lines) {
      const number = anchor.side === "new" ? line.newLine : line.oldLine;
      if (number !== null && number >= anchor.line && number <= anchor.endLine) lines.push(line);
    }
  }
  return lines;
}

/**
 * The reviewer proposes important or nit; the code decides pre_existing. A
 * finding is the change's own when its anchored lines include a line the diff
 * added or removed (a removed guard is the author's doing); when every
 * anchored line is unchanged context, the defect predates the change and is
 * pre_existing.
 */
export function classifySeverity(
  proposed: ProposedSeverity,
  anchor: Anchored,
  patch: string,
): Severity {
  const lines = anchoredLines(anchor, patch);
  if (lines.length === 0)
    throw new Error(`anchor ${anchor.path}:${anchor.line} is not in its patch`);
  return lines.some((line) => line.kind !== "context") ? proposed : "pre_existing";
}

// ── Convergence ──────────────────────────────────────────────────────────────

export interface NextRound {
  readonly action: "review" | "nothing_changed" | "revisit_approach";
  readonly round: number;
  /** Files the round reviews: new, or whose diff changed since the previous round. */
  readonly files: readonly string[];
  /** Files whose diff did not change: their findings carry over, not re-reviewed. */
  readonly carried: readonly string[];
}

/** path → patch SHA-256 of a sealed manifest, the input of `planNextRound`. */
export function patchDigests(sealed: SealedManifest): Map<string, string> {
  return new Map(sealed.selected.map((file) => [file.path, file.patchSha256]));
}

/**
 * Plan the next round. The cap is applied here, by the code: past it, the
 * answer is to revisit the approach, never another round.
 */
export function planNextRound(input: {
  readonly completedRounds: number;
  readonly previous: ReadonlyMap<string, string> | null;
  readonly current: ReadonlyMap<string, string>;
  readonly policy: ConvergencePolicy;
}): NextRound {
  const round = input.completedRounds + 1;
  if (round > input.policy.maxRounds) {
    return { action: "revisit_approach", round, files: [], carried: [] };
  }
  const paths = [...input.current.keys()].sort();
  const previous = input.previous;
  if (previous === null) return { action: "review", round, files: paths, carried: [] };
  const files = paths.filter((path) => previous.get(path) !== input.current.get(path));
  const carried = paths.filter((path) => previous.get(path) === input.current.get(path));
  return { action: files.length === 0 ? "nothing_changed" : "review", round, files, carried };
}

export interface PostSelection<F extends RoundFinding> {
  readonly post: readonly ComparedFinding<F>[];
  readonly suppressed: readonly {
    readonly finding: F;
    readonly identity: string;
    readonly reason: "already_posted";
  }[];
}

/** New and persisting findings are candidates; one already posted is never posted again. */
export function selectToPost<F extends RoundFinding>(
  compared: readonly ComparedFinding<F>[],
  alreadyPosted: ReadonlySet<string>,
): PostSelection<F> {
  const post: ComparedFinding<F>[] = [];
  const suppressed: { finding: F; identity: string; reason: "already_posted" }[] = [];
  for (const item of compared) {
    if (item.status !== "new" && item.status !== "persisting") continue;
    if (alreadyPosted.has(item.identity)) {
      suppressed.push({ finding: item.finding, identity: item.identity, reason: "already_posted" });
    } else post.push(item);
  }
  return { post, suppressed };
}
