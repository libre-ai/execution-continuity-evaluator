// Proof harness of the entry gates (gate-integrity section 5): every red case is replayed against
// a MUTANT of the gate in which the decisive condition is replaced by a no-op (never a deleted
// line, which would unbalance the structure and turn everything red for the wrong reason). A case
// is a pair — the verdict it pins holds on the gate, and does not hold on the mutant. A mutation
// that matches zero or several places, or changes nothing, fails the suite: the mutant must
// differ, once.
//
// Adapted from the fleet template `langgraph-gates.test.ts` of libre-ai/project-governance.
//
// The child process gets an environment built from nothing (PATH to find git, a scratch HOME):
// the equivalent of `env -i PATH=... HOME=...`, so an ambient variable of the CI run cannot
// decide a verdict. The fixtures are built at run time in throwaway git repositories; the names
// the telemetry gate refuses are assembled from parts by its test, so no tracked file carries one.

import { test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const HERE = import.meta.dir;

export const scratch = mkdtempSync(join(tmpdir(), "review-gates-"));
// Not `afterAll`: this module is shared by every test file of the run, and an `afterAll`
// registered from the first importer deletes the scratch area under the files that follow.
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

export const CLEAN_ENV = { PATH: process.env.PATH ?? "", HOME: scratch };

export interface Run {
  readonly exit: number;
  readonly out: string;
  readonly err: string;
}

export function spawnClean(cmd: string[]): Run {
  const result = Bun.spawnSync(cmd, { env: CLEAN_ENV, stdout: "pipe", stderr: "pipe" });
  return {
    exit: result.exitCode ?? -1,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  };
}

function git(repo: string, ...args: string[]): void {
  const result = spawnClean(["git", "-C", repo, ...args]);
  if (result.exit !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.err}`);
}

export type Entry = string | Buffer | { readonly link: string };

export function writeEntry(repo: string, path: string, entry: Entry): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  if (typeof entry === "string" || Buffer.isBuffer(entry)) writeFileSync(absolute, entry);
  else symlinkSync(entry.link, absolute);
}

/** Deletes a tracked file from the work tree: the index still lists it, the read then fails. */
export function rmFile(repo: string, path: string): void {
  rmSync(join(repo, path));
}

/** A throwaway git repository whose files are all staged: `git ls-files` sees them. */
export function newRepo(files: Record<string, Entry>): string {
  const repo = mkdtempSync(join(scratch, "repo-"));
  git(repo, "init", "-q");
  for (const [path, entry] of Object.entries(files)) writeEntry(repo, path, entry);
  git(repo, "add", "-A");
  return repo;
}

/** An executable file in the scratch area, outside any repository. */
export function writeExecutable(name: string, content: string): string {
  const directory = mkdtempSync(join(scratch, "bin-"));
  const path = join(directory, name);
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

let mutants = 0;

/** The gate with `from` replaced by `to`, exactly once, in its own directory. */
export function mutantOf(gate: string, from: string, to: string): string {
  const source = readFileSync(gate, "utf8");
  const first = source.indexOf(from);
  if (from === to || first === -1 || source.indexOf(from, first + 1) !== -1) {
    throw new Error(`a no-op mutation needs exactly one occurrence of: ${from}`);
  }
  const directory = join(scratch, `mutant-${mutants++}`);
  mkdirSync(directory);
  const path = join(directory, basename(gate));
  writeFileSync(
    path,
    source.replace(from, () => to),
  );
  return path;
}

export interface Case {
  readonly name: string;
  readonly files: Record<string, Entry>;
  /** Runs after the files are staged: delete a tracked file, add an untracked one. */
  readonly prepare?: (repo: string) => void;
  /** `plain`: the root is a directory that is not a git work tree. */
  readonly root?: "plain";
  /** Arguments after --root; a function receives the repository (to point at scratch files). */
  readonly args?: readonly string[] | ((repo: string) => string[]);
  /** The verdict the case pins. It must hold on the gate and fail on the mutant. */
  readonly holds: (run: Run) => boolean;
  /** The no-op: the decisive text of the gate, and what replaces it. */
  readonly mutation: readonly [from: string, to: string];
}

export const describeRun = (run: Run) =>
  `exit ${run.exit}\n--- stdout\n${run.out}--- stderr\n${run.err}`;

export function prove(gate: string, cases: readonly Case[]): void {
  test.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const repo = c.root === "plain" ? mkdtempSync(join(scratch, "plain-")) : newRepo(c.files);
    c.prepare?.(repo);
    const extra = typeof c.args === "function" ? c.args(repo) : (c.args ?? []);
    const args = [`--root=${repo}`, ...extra];

    const original = spawnClean([process.execPath, gate, ...args]);
    if (!c.holds(original)) throw new Error(`does not hold on the gate:\n${describeRun(original)}`);

    const mutant = mutantOf(gate, c.mutation[0], c.mutation[1]);
    const mutated = spawnClean([process.execPath, mutant, ...args]);
    // A mutant that crashes proves the mutation broke the program, not that the case checks anything.
    if (/\b(?:TypeError|ReferenceError|SyntaxError)\b|\n\s+at /.test(mutated.err)) {
      throw new Error(
        `the mutant crashed instead of changing the verdict:\n${describeRun(mutated)}`,
      );
    }
    if (c.holds(mutated)) throw new Error(`still holds on the mutant:\n${describeRun(mutated)}`);
  });
}

type Needle = string | RegExp;
const found = (text: string, needle: Needle) =>
  typeof needle === "string" ? text.includes(needle) : needle.test(text);

/** Exit 1 and every needle on stderr. */
export const refuses =
  (...needles: Needle[]) =>
  (run: Run) =>
    run.exit === 1 && needles.every((needle) => found(run.err, needle));

/** Exit 0 and every needle on stdout. */
export const accepts =
  (...needles: Needle[]) =>
  (run: Run) =>
    run.exit === 0 && needles.every((needle) => found(run.out, needle));
