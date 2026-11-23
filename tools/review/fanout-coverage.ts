import { createHash } from "node:crypto";

// Coverage and anchoring for the review fan-out: what the code guarantees about
// a review, so that only judgement is left to the model.
//
//   * which files are reviewed: a pure selection with an enumerated reason for
//     every exclusion, sealed into a manifest whose identity hashes the base,
//     the head, every selected file's diff, the rules and the reviewer;
//   * the proof each one was: every selected file ends in exactly one state,
//     and a review is complete only when all of them are reviewed or reused;
//   * where a finding points: the model quotes code, the code finds the line
//     and the side, and a finding it cannot place is never publishable.
//
// Everything here is pure, except `loadRulesAtBase`, which reads through an
// injected reader. The effects (git) live in fanout-run.ts.

// ── Diff entries ─────────────────────────────────────────────────────────────

export type DiffStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

export interface DiffChange {
  readonly status: DiffStatus;
  /** Path on the head side; for a deletion, the path the base had. */
  readonly path: string;
  /** Previous path of a rename or a copy; null otherwise. */
  readonly oldPath: string | null;
}

export interface DiffEntry extends DiffChange {
  readonly binary: boolean;
  /** Size of this file's patch in bytes; null when the patch was never read (a secret). */
  readonly patchBytes: number | null;
  /** SHA-256 of this file's patch; null when the patch was never read (a secret). */
  readonly patchSha256: string | null;
}

const NAME_STATUS: Readonly<Record<string, DiffStatus>> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

/**
 * Parse `git diff --name-status -z`. A status this tool does not know
 * (unmerged, unknown) or a truncated record is refused: a change that the
 * selection never sees is a file the manifest would silently not cover.
 */
export function parseNameStatusZ(raw: string): DiffChange[] {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: DiffChange[] = [];
  let index = 0;
  while (index < fields.length) {
    const code = fields[index] ?? "";
    const status = NAME_STATUS[code.charAt(0)];
    if (status === undefined || !/^[A-Z]\d*$/.test(code)) {
      throw new Error(`name-status: unknown status ${JSON.stringify(code)}`);
    }
    const twoPaths = status === "renamed" || status === "copied";
    const needed = twoPaths ? 2 : 1;
    const paths = fields.slice(index + 1, index + 1 + needed);
    if (paths.length < needed || paths.some((path) => path.length === 0)) {
      throw new Error(`name-status: truncated record for status ${code}`);
    }
    changes.push(
      twoPaths
        ? { status, path: paths[1] as string, oldPath: paths[0] as string }
        : { status, path: paths[0] as string, oldPath: null },
    );
    index += 1 + needed;
  }
  return changes;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Measure and fingerprint one file's patch. Binary is git's own header line,
 * matched at the start of a line: every hunk line carries a one-character
 * prefix (" ", "+", "-"), so content written by the author can never start
 * with it and declare its own file binary (which would exclude it from review).
 */
export function describePatch(change: DiffChange, patch: string): DiffEntry {
  const binary = patch
    .split("\n")
    .some((line) => line.startsWith("Binary files ") || line === "GIT binary patch");
  return {
    ...change,
    binary,
    patchBytes: Buffer.byteLength(patch, "utf8"),
    patchSha256: sha256Hex(patch),
  };
}

// ── Secret paths ─────────────────────────────────────────────────────────────
//
// The secret policy is code, not data: rules are read from the reviewed
// repository, and no repository may narrow it. Matching is on lowercase
// segments, so a file without an extension or whose name starts with a dot is
// covered like any other (the extension filter of the source tool let them by).

const SECRET_BASENAMES = new Set([
  ".env",
  ".git-credentials",
  ".pgpass",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".dockercfg",
  ".htpasswd",
  "credentials",
  "credentials.json",
  ".credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_ecdsa_sk",
  "id_ed25519_sk",
]);
const SECRET_EXTENSIONS = [
  ".env",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".ppk",
] as const;
const SECRET_PATH_SUFFIXES = [
  ".docker/config.json",
  ".kube/config",
  ".config/gh/hosts.yml",
] as const;
const SECRET_DIRECTORIES = new Set([".ssh", ".gnupg"]);

export function isSecretPath(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const name = segments.at(-1) ?? "";
  if (SECRET_BASENAMES.has(name) || name.startsWith(".env.")) return true;
  if (SECRET_EXTENSIONS.some((extension) => name.endsWith(extension) && name !== extension)) {
    return true;
  }
  if (SECRET_PATH_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(`/${suffix}`))) {
    return true;
  }
  return segments.slice(0, -1).some((segment) => SECRET_DIRECTORIES.has(segment));
}

/**
 * The read guard. Every later read of the review (evidence, rules, file
 * contents handed to a reviewer) goes through it, not only the selection: the
 * source tool filtered secrets at selection and let its read tools open them.
 * `denied` carries the paths a selection marked, which covers a secret renamed
 * to an innocent name.
 */
export function assertReadable(path: string, denied: Iterable<string> = []): void {
  if (isSecretPath(path) || new Set(denied).has(path)) {
    throw new Error(`refusing to read a secret path: ${JSON.stringify(path)}`);
  }
}

// ── Rules ────────────────────────────────────────────────────────────────────

export interface ExclusionRule {
  readonly pattern: string;
  readonly note: string;
}

export interface ZoneRule {
  readonly pattern: string;
  /** Short reviewer instruction for this zone (what failure looks like here). */
  readonly guidance: string;
}

export interface ReviewRules {
  readonly maxPatchBytes: number;
  readonly exclude: readonly ExclusionRule[];
  readonly zones: readonly ZoneRule[];
}

export const REVIEW_RULES_SCHEMA = "review-rules.v1";
export const REVIEW_RULES_PATH = "docs/reviews/rules.v1.json";
const MAX_GUIDANCE_LENGTH = 500;
const MAX_PATTERN_LENGTH = 200;

export const DEFAULT_REVIEW_RULES: ReviewRules = {
  maxPatchBytes: 524288,
  exclude: [],
  zones: [],
};

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${where}: unknown field ${JSON.stringify(key)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patternError(pattern: unknown): string | null {
  if (typeof pattern !== "string" || pattern.length === 0) return "non-empty string required";
  if (pattern.length > MAX_PATTERN_LENGTH) return `longer than ${MAX_PATTERN_LENGTH} characters`;
  if (pattern.startsWith("/") || pattern.includes("..") || /[\0\n\r]/.test(pattern)) {
    return "repo-relative, without '..' or control characters";
  }
  return null;
}

/** Validate a rules document; any unknown or unsafe field refuses the whole document. */
export function parseReviewRules(raw: unknown): ReviewRules {
  if (!isRecord(raw)) throw new Error("review rules: a JSON object is required");
  const errors: string[] = [];
  assertKnownFields(raw, ["schema", "maxPatchBytes", "exclude", "zones"], "review rules", errors);
  if (raw.schema !== REVIEW_RULES_SCHEMA) {
    errors.push(`review rules: schema must be ${JSON.stringify(REVIEW_RULES_SCHEMA)}`);
  }
  const maxPatchBytes = raw.maxPatchBytes ?? DEFAULT_REVIEW_RULES.maxPatchBytes;
  if (typeof maxPatchBytes !== "number" || !Number.isInteger(maxPatchBytes) || maxPatchBytes < 1) {
    errors.push("review rules: maxPatchBytes must be a positive integer");
  }

  const exclude: ExclusionRule[] = [];
  for (const [index, rule] of (Array.isArray(raw.exclude) ? raw.exclude : []).entries()) {
    const where = `review rules: exclude[${index}]`;
    if (!isRecord(rule)) {
      errors.push(`${where}: object required`);
      continue;
    }
    assertKnownFields(rule, ["pattern", "note"], where, errors);
    const problem = patternError(rule.pattern);
    if (problem !== null) errors.push(`${where}: pattern ${problem}`);
    if (typeof rule.note !== "string" || rule.note.trim().length === 0) {
      errors.push(`${where}: note (why it is excluded) required`);
    }
    if (problem === null && typeof rule.note === "string") {
      exclude.push({ pattern: rule.pattern as string, note: rule.note });
    }
  }
  if (raw.exclude !== undefined && !Array.isArray(raw.exclude)) {
    errors.push("review rules: exclude must be an array");
  }

  const zones: ZoneRule[] = [];
  for (const [index, zone] of (Array.isArray(raw.zones) ? raw.zones : []).entries()) {
    const where = `review rules: zones[${index}]`;
    if (!isRecord(zone)) {
      errors.push(`${where}: object required`);
      continue;
    }
    assertKnownFields(zone, ["pattern", "guidance"], where, errors);
    const problem = patternError(zone.pattern);
    if (problem !== null) errors.push(`${where}: pattern ${problem}`);
    const guidance = typeof zone.guidance === "string" ? zone.guidance.trim() : "";
    if (guidance.length === 0 || guidance.length > MAX_GUIDANCE_LENGTH) {
      errors.push(`${where}: guidance must be 1 to ${MAX_GUIDANCE_LENGTH} characters`);
    }
    if (problem === null && guidance.length > 0 && guidance.length <= MAX_GUIDANCE_LENGTH) {
      zones.push({ pattern: zone.pattern as string, guidance });
    }
  }
  if (raw.zones !== undefined && !Array.isArray(raw.zones)) {
    errors.push("review rules: zones must be an array");
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { maxPatchBytes: maxPatchBytes as number, exclude, zones };
}

function matches(pattern: string, path: string): boolean {
  return new Bun.Glob(pattern).match(path);
}

/** The zone rule for a path: the first zone whose pattern matches, or null. */
export function ruleFor(path: string, rules: ReviewRules): ZoneRule | null {
  return rules.zones.find((zone) => matches(zone.pattern, path)) ?? null;
}

/** Reads `path` at `revision`; null when the path is absent there, a throw when unreadable. */
export type RevisionReader = (revision: string, path: string) => Promise<string | null>;

export interface LoadedRules {
  readonly rules: ReviewRules;
  /** Where the rules came from, written to the manifest. */
  readonly source: string;
}

/**
 * Read the rules from the BASE tree, never from the head. Rules read from the
 * reviewed tree let the author of a change rewrite the rules and exclusions
 * that judge it (the defect of the source tool). Only an absent file falls
 * back to the defaults; an unreadable or invalid one fails the review.
 */
export async function loadRulesAtBase(
  read: RevisionReader,
  base: string,
  rulesPath: string,
): Promise<LoadedRules> {
  assertReadable(rulesPath);
  const text = await read(base, rulesPath);
  if (text === null) {
    return { rules: DEFAULT_REVIEW_RULES, source: `default (no ${rulesPath} at ${base})` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`review rules at ${rulesPath}@${base} are not valid JSON: ${String(cause)}`);
  }
  return { rules: parseReviewRules(raw), source: `${rulesPath}@${base}` };
}

// ── Selection ────────────────────────────────────────────────────────────────

export type ExclusionReason = "secret_path" | "binary" | "excluded_by_rule" | "too_large";

export interface Exclusion {
  readonly path: string;
  readonly reason: ExclusionReason;
  /** The rule pattern, for `excluded_by_rule`; null otherwise. */
  readonly rule: string | null;
}

export interface Selection {
  readonly selected: readonly DiffEntry[];
  readonly excluded: readonly Exclusion[];
  /** Paths no later step may read: every name a secret file had in this diff. */
  readonly readDenied: readonly string[];
}

const byPath = <T extends { readonly path: string }>(a: T, b: T): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Pure selection. Order of the filters: secret, binary, rule, size. Secret
 * comes first so that a binary key store is reported, and denied, as a secret.
 */
export function selectFiles(entries: readonly DiffEntry[], rules: ReviewRules): Selection {
  const seen = new Set<string>();
  const selected: DiffEntry[] = [];
  const excluded: Exclusion[] = [];
  const readDenied = new Set<string>();
  for (const file of entries) {
    if (seen.has(file.path)) throw new Error(`diff lists ${JSON.stringify(file.path)} twice`);
    seen.add(file.path);
    const names = file.oldPath === null ? [file.path] : [file.oldPath, file.path];
    if (names.some(isSecretPath)) {
      for (const name of names) readDenied.add(name);
      excluded.push({ path: file.path, reason: "secret_path", rule: null });
      continue;
    }
    if (file.binary) {
      excluded.push({ path: file.path, reason: "binary", rule: null });
      continue;
    }
    const rule = rules.exclude.find((candidate) => matches(candidate.pattern, file.path));
    if (rule !== undefined) {
      excluded.push({ path: file.path, reason: "excluded_by_rule", rule: rule.pattern });
      continue;
    }
    if (file.patchBytes === null || file.patchSha256 === null) {
      throw new Error(`no patch was read for ${JSON.stringify(file.path)}, which is not a secret`);
    }
    if (file.patchBytes > rules.maxPatchBytes) {
      excluded.push({ path: file.path, reason: "too_large", rule: null });
      continue;
    }
    selected.push(file);
  }
  return {
    selected: selected.sort(byPath),
    excluded: excluded.sort(byPath),
    readDenied: [...readDenied].sort(),
  };
}

// ── Sealed manifest ──────────────────────────────────────────────────────────

/** JSON with sorted keys and no insignificant whitespace; refuses what JSON cannot carry. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: finite numbers only");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => {
        const item = value[key];
        if (item === undefined) throw new Error(`canonicalJson: undefined at key ${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(",")}}`;
  }
  throw new Error(`canonicalJson: cannot serialize a ${typeof value}`);
}

export interface ReviewerIdentity {
  readonly provider: string;
  readonly model: string;
  readonly thinking: string;
}

export interface SealedFile {
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: DiffStatus;
  readonly patchSha256: string;
}

export interface SealedManifest {
  readonly schema: "fanout-coverage-manifest.v1";
  /** SHA-256 of the canonical (base, head, files, rulesSha256, reviewer). */
  readonly reviewId: string;
  readonly base: string;
  readonly head: string;
  readonly rulesSha256: string;
  readonly rulesSource: string;
  readonly reviewer: ReviewerIdentity;
  /** Roles the campaign runs; recorded, not part of the identity (see settleFromCampaign). */
  readonly roles: readonly string[];
  readonly selected: readonly SealedFile[];
  readonly excluded: readonly Exclusion[];
  readonly readDenied: readonly string[];
}

export interface SealInput {
  readonly base: string;
  readonly head: string;
  readonly selection: Selection;
  readonly rules: ReviewRules;
  readonly rulesSource: string;
  readonly reviewer: ReviewerIdentity;
  readonly roles: readonly string[];
}

export function sealManifest(input: SealInput): SealedManifest {
  const selected: SealedFile[] = input.selection.selected.map((file) => ({
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    patchSha256: file.patchSha256 as string,
  }));
  selected.sort(byPath);
  const rulesSha256 = sha256Hex(canonicalJson(input.rules));
  const reviewer = {
    provider: input.reviewer.provider,
    model: input.reviewer.model,
    thinking: input.reviewer.thinking,
  };
  const reviewId = sha256Hex(
    canonicalJson({ base: input.base, head: input.head, files: selected, rulesSha256, reviewer }),
  );
  return {
    schema: "fanout-coverage-manifest.v1",
    reviewId,
    base: input.base,
    head: input.head,
    rulesSha256,
    rulesSource: input.rulesSource,
    reviewer,
    roles: [...input.roles],
    selected,
    excluded: [...input.selection.excluded],
    readDenied: [...input.selection.readDenied],
  };
}

// ── Settlement and closure ───────────────────────────────────────────────────

export type FailureClass =
  | "budget_exhausted"
  | "reviewer_failed"
  | "prior_unattested"
  | "read_refused"
  | "not_reached";

export type FileOutcome =
  | { readonly state: "reviewed" }
  | { readonly state: "reused" }
  | { readonly state: "failed"; readonly failure: FailureClass };

export type FileRecord = { readonly path: string } & FileOutcome;

export type CoverageStatus = "complete" | "partial" | "empty";

export interface CoverageCounts {
  readonly selected: number;
  readonly reviewed: number;
  readonly reused: number;
  readonly failed: number;
  readonly failedByClass: Readonly<Partial<Record<FailureClass, number>>>;
}

export interface ClosedManifest extends SealedManifest {
  readonly status: CoverageStatus;
  readonly budgetExhausted: boolean;
  readonly files: readonly FileRecord[];
  readonly counts: CoverageCounts;
}

/**
 * Close a sealed manifest. Each selected file ends in exactly one state; a
 * file nobody settled is `failed`, never dropped. Complete requires at least
 * one selected file, all reviewed or reused, and a budget that held: a review
 * stopped by its budget is partial even if the files it reached were settled.
 */
export function closeManifest(
  sealed: SealedManifest,
  outcomes: ReadonlyMap<string, FileOutcome>,
  options: { readonly budgetExhausted: boolean },
): ClosedManifest {
  const sealedPaths = new Set(sealed.selected.map((file) => file.path));
  for (const path of outcomes.keys()) {
    if (!sealedPaths.has(path)) {
      throw new Error(`outcome for ${JSON.stringify(path)}, which is not in the sealed set`);
    }
  }
  const unsettled: FailureClass = options.budgetExhausted ? "budget_exhausted" : "not_reached";
  const files: FileRecord[] = sealed.selected.map((file) => ({
    path: file.path,
    ...(outcomes.get(file.path) ?? { state: "failed", failure: unsettled }),
  }));

  let reviewed = 0;
  let reused = 0;
  let failed = 0;
  const failedByClass: Partial<Record<FailureClass, number>> = {};
  for (const file of files) {
    if (file.state === "reviewed") reviewed += 1;
    else if (file.state === "reused") reused += 1;
    else {
      failed += 1;
      failedByClass[file.failure] = (failedByClass[file.failure] ?? 0) + 1;
    }
  }
  if (reviewed + reused + failed !== sealed.selected.length) {
    throw new Error("coverage counters do not sum to the sealed set");
  }
  const status: CoverageStatus =
    sealed.selected.length === 0
      ? "empty"
      : failed === 0 && !options.budgetExhausted
        ? "complete"
        : "partial";
  return {
    ...sealed,
    status,
    budgetExhausted: options.budgetExhausted,
    files,
    counts: { selected: sealed.selected.length, reviewed, reused, failed, failedByClass },
  };
}

export interface CampaignSettlement {
  /** Role passes this run executed, with whether each ended with an accepted verdict. */
  readonly executed: readonly { readonly role: string; readonly ok: boolean }[];
  /** Roles skipped because a verdict was already recorded. */
  readonly skippedRoles: readonly string[];
  /** The manifest a previous run closed in the same output directory, if any. */
  readonly prior: ClosedManifest | null;
}

/**
 * Settle the sealed files from what the campaign did. Every role pass is
 * handed the whole sealed scope, and review-verdict.v0.1 carries no per-file
 * attestation, so a file is `reviewed` when every role ended with an accepted
 * verdict over that scope. A role skipped for an existing verdict counts only
 * if a complete prior manifest of the SAME identity covered that role: a
 * verdict on another diff, other rules or another model attests nothing here.
 */
export function settleFromCampaign(
  sealed: SealedManifest,
  campaign: CampaignSettlement,
): Map<string, FileOutcome> {
  const paths = sealed.selected.map((file) => file.path);
  const settleAll = (outcome: FileOutcome) =>
    new Map<string, FileOutcome>(paths.map((path) => [path, outcome]));

  if (campaign.executed.some((pass) => !pass.ok)) {
    return settleAll({ state: "failed", failure: "reviewer_failed" });
  }
  if (campaign.skippedRoles.length > 0) {
    const prior = campaign.prior;
    const attested =
      prior !== null &&
      prior.reviewId === sealed.reviewId &&
      prior.status === "complete" &&
      campaign.skippedRoles.every((role) => prior.roles.includes(role));
    if (!attested) return settleAll({ state: "failed", failure: "prior_unattested" });
  }
  const covered = new Set([
    ...campaign.executed.map((pass) => pass.role),
    ...campaign.skippedRoles,
  ]);
  if (!sealed.roles.every((role) => covered.has(role))) return new Map();
  return settleAll({ state: campaign.executed.length > 0 ? "reviewed" : "reused" });
}

function tally(entries: readonly [string, number][]): string {
  return [...entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
}

/** The one line a run prints about coverage: status, then every counter. */
export function formatClosure(closed: ClosedManifest): string {
  const { counts } = closed;
  const failedDetail =
    counts.failed === 0
      ? ""
      : ` (${tally(Object.entries(counts.failedByClass) as [string, number][])})`;
  const reasons = new Map<string, number>();
  for (const exclusion of closed.excluded) {
    reasons.set(exclusion.reason, (reasons.get(exclusion.reason) ?? 0) + 1);
  }
  const excludedDetail = reasons.size === 0 ? "" : ` (${tally([...reasons.entries()])})`;
  return (
    `coverage ${closed.status}: ${counts.selected} selected — ${counts.reviewed} reviewed, ` +
    `${counts.reused} reused, ${counts.failed} failed${failedDetail}; ` +
    `${closed.excluded.length} excluded${excludedDetail}; review ${closed.reviewId.slice(0, 12)}`
  );
}

/**
 * The scope handed to every pass: each sealed file and the zone rule that
 * applies to it. Paths are JSON-quoted, since an author can name a file with
 * newlines or delimiters; the caller still wraps the whole text as untrusted.
 */
export function formatReviewScope(sealed: SealedManifest, rules: ReviewRules): string {
  const lines = [
    `Sealed review ${sealed.reviewId}, ${sealed.base.slice(0, 12)}..${sealed.head.slice(0, 12)}: ` +
      `${sealed.selected.length} file(s) in scope; any other file is out of this review.`,
  ];
  for (const file of sealed.selected) {
    const zone = ruleFor(file.path, rules);
    const rule = zone === null ? "" : ` — zone ${JSON.stringify(zone.pattern)}: ${zone.guidance}`;
    lines.push(`- ${JSON.stringify(file.path)} (${file.status})${rule}`);
  }
  return lines.join("\n");
}

/** What a run prints once the scope is sealed; `detailed` (a dry run) lists every file. */
export function formatSealPreview(
  sealed: SealedManifest,
  rules: ReviewRules,
  detailed: boolean,
): string[] {
  const reasons = new Map<string, number>();
  for (const exclusion of sealed.excluded) {
    reasons.set(exclusion.reason, (reasons.get(exclusion.reason) ?? 0) + 1);
  }
  const excludedDetail = reasons.size === 0 ? "" : ` (${tally([...reasons.entries()])})`;
  const lines = [
    `coverage sealed: ${sealed.selected.length} selected, ${sealed.excluded.length} excluded` +
      `${excludedDetail}; rules ${sealed.rulesSource} (sha256 ${sealed.rulesSha256.slice(0, 12)}); ` +
      `review ${sealed.reviewId.slice(0, 12)}`,
  ];
  if (!detailed) return lines;
  for (const file of sealed.selected) {
    const zone = ruleFor(file.path, rules);
    lines.push(
      `- review ${JSON.stringify(file.path)}${zone === null ? "" : ` [zone ${JSON.stringify(zone.pattern)}]`}`,
    );
  }
  for (const exclusion of sealed.excluded) {
    const rule = exclusion.rule === null ? "" : ` [rule ${JSON.stringify(exclusion.rule)}]`;
    lines.push(`- exclude ${JSON.stringify(exclusion.path)}: ${exclusion.reason}${rule}`);
  }
  return lines;
}

// ── Anchoring ────────────────────────────────────────────────────────────────

export interface PatchLine {
  readonly kind: "context" | "added" | "removed";
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

export interface PatchHunk {
  readonly lines: readonly PatchLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse the hunks of one file's unified diff. A hunk ends when its declared
 * old and new counts are consumed, so a content line can never be read as a
 * header and a header can never be read as content.
 */
export function parsePatchHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  const lines = patch.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    index += 1;
    if (!line.startsWith("@@")) continue;
    const header = HUNK_HEADER.exec(line);
    if (header === null) throw new Error(`malformed hunk header: ${JSON.stringify(line)}`);
    let oldLine = Number(header[1]);
    let newLine = Number(header[3]);
    let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    let newLeft = header[4] === undefined ? 1 : Number(header[4]);
    const hunk: PatchLine[] = [];
    while ((oldLeft > 0 || newLeft > 0) && index < lines.length) {
      const body = lines[index] ?? "";
      index += 1;
      if (body.startsWith("\\")) continue; // "\ No newline at end of file"
      const marker = body.charAt(0);
      const text = body.slice(1);
      if (marker === "+") {
        hunk.push({ kind: "added", text, oldLine: null, newLine });
        newLine += 1;
        newLeft -= 1;
      } else if (marker === "-") {
        hunk.push({ kind: "removed", text, oldLine, newLine: null });
        oldLine += 1;
        oldLeft -= 1;
      } else {
        // " " is context; an empty line is a context line whose space was stripped.
        hunk.push({ kind: "context", text, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
    }
    hunks.push({ lines: hunk });
  }
  return hunks;
}

export type DiffSide = "new" | "old";

export interface QuotedFinding {
  readonly path: string;
  /** Code quoted by the reviewer, verbatim from the diff. */
  readonly existingCode: string;
}

export type UnanchoredReason =
  | "path_not_selected"
  | "empty_excerpt"
  | "excerpt_not_found"
  | "ambiguous_excerpt";

export type AnchorResult =
  | {
      readonly anchored: true;
      readonly path: string;
      readonly line: number;
      readonly endLine: number;
      readonly side: DiffSide;
    }
  | { readonly anchored: false; readonly path: string; readonly reason: UnanchoredReason };

interface SideMatch {
  readonly line: number;
  readonly endLine: number;
}

function matchesOnSide(hunks: readonly PatchHunk[], excerpt: readonly string[], side: DiffSide) {
  const found: SideMatch[] = [];
  for (const hunk of hunks) {
    const sequence = hunk.lines.filter((line) =>
      side === "new" ? line.kind !== "removed" : line.kind !== "added",
    );
    for (let start = 0; start + excerpt.length <= sequence.length; start += 1) {
      const window = sequence.slice(start, start + excerpt.length);
      if (window.every((line, offset) => line.text.trim() === excerpt[offset])) {
        const first = window[0] as PatchLine;
        const last = window.at(-1) as PatchLine;
        const number = (line: PatchLine) =>
          (side === "new" ? line.newLine : line.oldLine) as number;
        found.push({ line: number(first), endLine: number(last) });
      }
    }
  }
  return found;
}

/**
 * Place a quoted excerpt in the diff: the new side first, then the old side.
 * Lines compare after trimming, so indentation the reviewer re-flowed still
 * matches; an excerpt never spans two hunks. Zero matches on both sides, or
 * more than one on the side that matched, leaves the finding unanchored.
 */
export function anchorFinding(
  finding: QuotedFinding,
  sealedPaths: ReadonlySet<string>,
  patches: ReadonlyMap<string, string>,
): AnchorResult {
  const { path } = finding;
  if (!sealedPaths.has(path)) return { anchored: false, path, reason: "path_not_selected" };
  const excerpt = finding.existingCode.split("\n").map((line) => line.trim());
  while (excerpt.length > 0 && excerpt[0] === "") excerpt.shift();
  while (excerpt.length > 0 && excerpt.at(-1) === "") excerpt.pop();
  if (excerpt.length === 0) return { anchored: false, path, reason: "empty_excerpt" };
  const patch = patches.get(path);
  if (patch === undefined) throw new Error(`no patch held for sealed path ${JSON.stringify(path)}`);
  const hunks = parsePatchHunks(patch);
  for (const side of ["new", "old"] as const) {
    const found = matchesOnSide(hunks, excerpt, side);
    if (found.length > 1) return { anchored: false, path, reason: "ambiguous_excerpt" };
    const [match] = found;
    if (match !== undefined) return { anchored: true, path, ...match, side };
  }
  return { anchored: false, path, reason: "excerpt_not_found" };
}

export interface FindingPartition<F extends QuotedFinding> {
  readonly publishable: readonly {
    readonly finding: F;
    readonly anchor: Extract<AnchorResult, { anchored: true }>;
  }[];
  /** Never publishable, never dropped: each one is kept with the reason it was withheld. */
  readonly withheld: readonly { readonly finding: F; readonly reason: UnanchoredReason }[];
}

export function partitionFindings<F extends QuotedFinding>(
  findings: readonly F[],
  sealed: SealedManifest,
  patches: ReadonlyMap<string, string>,
): FindingPartition<F> {
  const sealedPaths = new Set(sealed.selected.map((file) => file.path));
  const publishable: FindingPartition<F>["publishable"][number][] = [];
  const withheld: FindingPartition<F>["withheld"][number][] = [];
  for (const finding of findings) {
    const anchor = anchorFinding(finding, sealedPaths, patches);
    if (anchor.anchored) publishable.push({ finding, anchor });
    else withheld.push({ finding, reason: anchor.reason });
  }
  return { publishable, withheld };
}

// ── Plan field ───────────────────────────────────────────────────────────────

export interface CoverageRequest {
  readonly base: string;
  readonly rulesPath: string;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RULES_PATH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Read the optional `coverage` field of a review plan: `{ base, rules? }`.
 * Kept out of `parsePlan` so the plan contract and its consumers are unchanged
 * for plans that ask for no coverage.
 */
export function parseCoverageRequest(rawPlan: unknown): CoverageRequest | null {
  if (!isRecord(rawPlan) || rawPlan.coverage === undefined) return null;
  const coverage = rawPlan.coverage;
  if (!isRecord(coverage)) throw new Error("coverage: an object { base, rules? } is required");
  const errors: string[] = [];
  assertKnownFields(coverage, ["base", "rules"], "coverage", errors);
  const base = typeof coverage.base === "string" ? coverage.base : "";
  if (!SHA_PATTERN.test(base)) errors.push("coverage.base: full 40-hex commit SHA required");
  const rulesPath = coverage.rules === undefined ? REVIEW_RULES_PATH : coverage.rules;
  if (
    typeof rulesPath !== "string" ||
    !RULES_PATH_PATTERN.test(rulesPath) ||
    rulesPath.includes("..")
  ) {
    errors.push("coverage.rules: repo-relative path in [A-Za-z0-9._/-], without '..'");
  }
  if (errors.length > 0) throw new Error(`invalid coverage request:\n- ${errors.join("\n- ")}`);
  assertReadable(rulesPath as string);
  return { base, rulesPath: rulesPath as string };
}
