import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { getRandomValues } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parsePlan } from "./fanout-core";
import { formatReviewScope, parseCoverageRequest } from "./fanout-coverage";
import {
  type CoverageFixture,
  disposeFixture,
  FIXTURE_RULES_PATH,
  makeCoverageFixture,
  setFakePiMode,
} from "./fanout-fixtures";
import {
  buildEvidenceDigest,
  type CampaignIo,
  COVERAGE_MANIFEST_NAME,
  concludeCoverage,
  type GitRunner,
  gitIn,
  openCampaign,
  type PreparedCoverage,
  prepareCoverage,
  reportJournal,
  runCampaignDirect,
} from "./fanout-run";

// The coverage manifest with the real effects: a throwaway repository with a
// base and a head, the stand-in `pi`, and the default driver.

setDefaultTimeout(30000);

const fixtures: CoverageFixture[] = [];
async function fixture(): Promise<CoverageFixture> {
  const created = await makeCoverageFixture();
  fixtures.push(created);
  return created;
}
afterEach(async () => {
  for (const created of fixtures.splice(0)) await disposeFixture(created);
});

async function planOf(f: CoverageFixture, outputName = "verdicts") {
  const raw = await Bun.file(f.planPath).json();
  const outputDir = join(f.dir, "out", outputName);
  return { plan: parsePlan({ ...raw, outputDir }), request: parseCoverageRequest(raw) };
}

function recordingGit(repoDir: string): { runGit: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const real = gitIn(repoDir);
  return {
    calls,
    runGit: (args) => {
      calls.push(args);
      return real(args);
    },
  };
}

async function campaign(f: CoverageFixture, prepared: PreparedCoverage, piMode: string) {
  const { plan } = await planOf(f);
  const lines: string[] = [];
  const io: CampaignIo = {
    log: (line) => lines.push(`log: ${line}`),
    error: (line) => lines.push(`err: ${line}`),
  };
  await setFakePiMode(f, piMode);
  let counter = 0;
  const outcome = await runCampaignDirect({
    plan,
    force: false,
    dryRun: false,
    makeId: () => `rp-cov-${++counter}`,
    hasRecordedVerdict: (job) => existsSync(job.outputPath),
    open: (campaignPlan) =>
      openCampaign(campaignPlan, {
        repoDir: f.dir,
        piBinary: f.piBinary,
        reviewScope: formatReviewScope(prepared.sealed, prepared.rules),
      }),
    verify: (journalPath, results) => reportJournal(journalPath, results, io),
    io,
  });
  const closed = await concludeCoverage(prepared, outcome, plan.outputDir, io);
  return { closed, lines, manifestPath: join(plan.outputDir, COVERAGE_MANIFEST_NAME) };
}

async function prepared(f: CoverageFixture): Promise<PreparedCoverage> {
  const { plan, request } = await planOf(f);
  if (request === null) throw new Error("the coverage fixture plan must request coverage");
  return prepareCoverage(plan, request, gitIn(f.dir));
}

describe("prepareCoverage on a real diff", () => {
  test("seals the selected set with rules read at the base, and never reads a secret's patch", async () => {
    const f = await fixture();
    const { plan, request } = await planOf(f);
    if (request === null) throw new Error("coverage requested");
    const { runGit, calls } = recordingGit(f.dir);
    const { sealed, patches } = await prepareCoverage(plan, request, runGit);

    expect(sealed.base).toBe(f.base);
    expect(sealed.head).toBe(f.commit);
    expect(sealed.rulesSource).toBe(`${FIXTURE_RULES_PATH}@${f.base}`);
    // The head's rules exclude everything; read from the head, nothing would be selected.
    expect(sealed.selected.map((file) => [file.path, file.status, file.oldPath])).toEqual([
      [FIXTURE_RULES_PATH, "modified", null],
      ["notes-subject.txt", "renamed", "subject.txt"],
      ["src/app.ts", "added", null],
    ]);
    expect(sealed.excluded).toEqual([
      { path: ".env", reason: "secret_path", rule: null },
      { path: "assets/logo.bin", reason: "binary", rule: null },
    ]);
    expect(sealed.readDenied).toEqual([".env"]);
    expect([...patches.keys()].sort()).toEqual([
      FIXTURE_RULES_PATH,
      "notes-subject.txt",
      "src/app.ts",
    ]);
    expect(calls.filter((args) => args.includes(".env"))).toEqual([]);
    expect(calls.some((args) => args.includes(`${f.commit}:${FIXTURE_RULES_PATH}`))).toBe(false);
    for (const args of calls.filter((call) => call.includes("diff"))) {
      expect(args).toContain("--no-ext-diff");
      expect(args).toContain("--no-textconv");
      expect(args[0]).toBe("--literal-pathspecs");
    }
  });
});

describe("concludeCoverage after a campaign", () => {
  test("every pass accepted: a complete manifest, written beside the verdicts", async () => {
    const f = await fixture();
    const coverage = await prepared(f);
    const { closed, lines, manifestPath } = await campaign(f, coverage, "approve");

    expect(closed.status).toBe("complete");
    expect(closed.counts).toEqual({
      selected: 3,
      reviewed: 3,
      reused: 0,
      failed: 0,
      failedByClass: {},
    });
    const written = await Bun.file(manifestPath).json();
    expect(written.reviewId).toBe(coverage.sealed.reviewId);
    expect(written.status).toBe("complete");
    expect(lines.some((line) => line.startsWith("log: coverage complete: 3 selected"))).toBe(true);
  });

  test("a failed pass leaves a partial manifest that is not declared complete", async () => {
    const f = await fixture();
    const { closed, lines } = await campaign(f, await prepared(f), "exit1");

    expect(closed.status).toBe("partial");
    expect(closed.counts.failedByClass).toEqual({ reviewer_failed: 3 });
    expect(lines.some((line) => line.includes("this review is not declared complete"))).toBe(true);
  });

  test("a re-run over recorded verdicts reuses a complete manifest of the same identity", async () => {
    const f = await fixture();
    const coverage = await prepared(f);
    await campaign(f, coverage, "approve");
    const again = await campaign(f, coverage, "approve");

    expect(again.closed.status).toBe("complete");
    expect(again.closed.counts.reused).toBe(3);
  });

  test("a prior manifest that is not a manifest attests nothing", async () => {
    const f = await fixture();
    const coverage = await prepared(f);
    const first = await campaign(f, coverage, "approve");
    await Bun.write(first.manifestPath, "{ torn");
    const again = await campaign(f, coverage, "approve");

    expect(again.closed.status).toBe("partial");
    expect(again.closed.counts.failedByClass).toEqual({ prior_unattested: 3 });
    expect(again.lines.some((line) => line.includes("unreadable — not trusted"))).toBe(true);
  });
});

describe("the evidence digest", () => {
  const key = { id: "test-key", secret: getRandomValues(new Uint8Array(32)) };

  test("carries the sealed scope, guarded, with each file's zone rule", async () => {
    const f = await fixture();
    const coverage = await prepared(f);
    const { plan } = await planOf(f);
    const digest = await buildEvidenceDigest(
      plan,
      key,
      f.dir,
      formatReviewScope(coverage.sealed, coverage.rules),
    );
    expect(digest).toContain("### review scope (sealed coverage manifest)");
    expect(digest).toContain('"src/app.ts" (added) — zone "src/**": Source: the guard must hold.');
    expect(digest).not.toContain("fixture-secret-value");
  });

  test("refuses a declared evidence file that is a secret path", async () => {
    const f = await fixture();
    const { plan } = await planOf(f);
    await expect(
      buildEvidenceDigest({ ...plan, evidence: ["config/.env"] }, key, f.dir),
    ).rejects.toThrow(/secret path/);
  });
});
