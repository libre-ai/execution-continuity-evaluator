// Scope of the LangGraph graph — shared by check-advisory-floor.ts and check-osv-advisories.ts
// (CA-18; ADR-0058 section 3, condition 1: "toute version résolue du graphe est supérieure ou
// égale à la version corrigée de chaque avis").
//
// docs/prd.md section 9 places the graph in the Bun workspace of tools/review: its manifest and its
// lockfile are the two files the advisory gates compare. A package of the publisher family declared
// or resolved ANYWHERE ELSE in the repository is a graph those gates never compare: they would
// print "vacuous" / "not applicable" and exit 0 on a vulnerable version. This module is the
// sweep that closes that gap, in one place, so that the two instruments cannot disagree on it.
//
// The sweep is textual, over the whole file, like the persistence gate's: a dependency, an
// override, an `npm:` alias and a lockfile entry are all seen under the same rule, and so is a
// lockfile of a format this repository does not use (a textual match needs no reader that would
// never be exercised). It reads every TRACKED `package.json` and lockfile except the two files of
// the graph, and counts them so that the counters sum to the tracked universe.
//
// What it does NOT see: an untracked file, and a package of the family reached under another name
// (an alias to a git or tarball URL that carries no name of the family).
//
// Self-contained apart from `node:`: no dependency on a gate, so that a gate and this module can be
// mutated together in a directory of their own (see harness.ts, `mutantOf`).

import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

// The packages the publisher ships for this runtime. A declared or resolved one makes the floor
// non-vacuous and the osv instrument applicable.
export const FAMILY = /^(?:@langchain\/|langchain$)/;

// FAMILY, read inside a text instead of on a whole name: the scoped prefix, or the bare name
// delimited so that `langchain-community`, `my-langchain` and `langchain.ts` are other names.
const FAMILY_REFERENCE = /@langchain\/[a-z0-9~-][a-z0-9._~-]*|(?<![\w@.~-])langchain(?![\w.~-])/gi;

const MANIFESTS = new Set(["package.json"]);
const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

export interface Reference {
  readonly line: number;
  readonly name: string;
}

/** One reference per (line, name): a name written twice on a line is one reference. */
export function familyReferences(text: string): Reference[] {
  const references: Reference[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const names = new Set(
      [...line.matchAll(FAMILY_REFERENCE)].map((match) => match[0].toLowerCase()),
    );
    for (const name of names) references.push({ line: index + 1, name });
  }
  return references;
}

/** The counters sum to `tracked`: each tracked path lands in exactly one of the first five. */
export interface ScopeSweep {
  readonly tracked: number;
  readonly graph: number;
  readonly manifests: number;
  readonly lockfiles: number;
  readonly outOfScope: number;
  readonly unreadable: readonly string[];
  readonly found: readonly string[];
}

/**
 * `graphPaths`: the manifest and the lockfile the gate itself compares. They are counted, not
 * swept: the gate reads them with a real reader and fails closed on them.
 */
export function sweepOutsideGraph(
  root: string,
  tracked: readonly string[],
  graphPaths: readonly string[],
): ScopeSweep {
  const unreadable: string[] = [];
  const found: string[] = [];
  let graph = 0;
  let manifests = 0;
  let lockfiles = 0;
  let outOfScope = 0;
  for (const path of tracked) {
    if (graphPaths.includes(path)) {
      graph += 1;
      continue;
    }
    const name = basename(path);
    const isManifest = MANIFESTS.has(name);
    if (!isManifest && !LOCKFILES.has(name)) {
      outOfScope += 1;
      continue;
    }
    let text: string;
    try {
      if (!lstatSync(join(root, path)).isFile()) {
        // A manifest behind a link is versioned as the link: it cannot be read here, so it fails.
        unreadable.push(`${path} (not a regular file)`);
        continue;
      }
      // latin1: package names are ASCII, and a binary lockfile must be swept, not skipped.
      text = readFileSync(join(root, path)).toString("latin1");
    } catch {
      unreadable.push(`${path} (unreadable)`);
      continue;
    }
    if (isManifest) manifests += 1;
    else lockfiles += 1;
    for (const reference of familyReferences(text)) {
      found.push(`${path}:${reference.line}: ${reference.name}`);
    }
  }
  return { tracked: tracked.length, graph, manifests, lockfiles, outOfScope, unreadable, found };
}

/** The failures of a sweep; `graphPaths` is named in the message so that the fix is in the text. */
export function scopeFailures(sweep: ScopeSweep, graphPaths: readonly string[]): string[] {
  const failures: string[] = [];
  for (const reference of sweep.found) {
    failures.push(
      `${reference} is a package of the publisher family outside the graph workspace: ` +
        `docs/prd.md section 9 places the graph in the Bun workspace of tools/review ` +
        `(${graphPaths.join(", ")}), the only files this gate compares to the advisories; ` +
        "declare and resolve it there",
    );
  }
  for (const path of sweep.unreadable) {
    failures.push(`${path}: a tracked manifest or lockfile outside the graph that was not read`);
  }
  return failures;
}

/** The volume line, without its gate prefix. */
export function scopeVolume(sweep: ScopeSweep): string {
  return (
    `scope: ${sweep.tracked} tracked file(s): ${sweep.graph} of the graph workspace, ` +
    `${sweep.manifests} manifest(s) and ${sweep.lockfiles} lockfile(s) outside it examined, ` +
    `${sweep.outOfScope} out of scope, ${sweep.unreadable.length} unreadable; ` +
    `${sweep.found.length} publisher-family reference(s) outside the graph workspace`
  );
}

/** Declared on every run: what the sweep cannot see. */
export const SCOPE_NOT_SEEN =
  "scope: not seen — an untracked manifest or lockfile, a package of the family reached under a name that is not its own";
