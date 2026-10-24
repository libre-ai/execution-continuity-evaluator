import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CA-20: the whole dependency graph of tools/review, transitives included,
// carries admitted licences. The gate is the fleet's (`check-js-licenses.ts` of
// @libre-ai/governance); it reads the manifests INSTALLED under node_modules
// and the lock only for first-party provenance. These tests run it for real on
// this directory, then on a copy that holds a licence outside the list.

const REVIEW_DIR = import.meta.dir;
const GATE = join(
  REVIEW_DIR,
  "..",
  "..",
  "node_modules/@libre-ai/governance/tools/quality/check-js-licenses.ts",
);

interface GateRun {
  readonly exitCode: number;
  readonly output: string;
}

async function runGate(cwd: string): Promise<GateRun> {
  expect(await Bun.file(GATE).exists(), `${GATE} is installed`).toBe(true);
  const proc = Bun.spawn([process.execPath, GATE], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function copyOfInstall(licenses: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "review-licenses-"));
  scratch.push(dir);
  await copyFile(join(REVIEW_DIR, "bun.lock"), join(dir, "bun.lock"));
  for (const [name, license] of Object.entries(licenses)) {
    const packageDir = join(dir, "node_modules", name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", license }),
    );
  }
  return dir;
}

describe("licence closure of tools/review", () => {
  test("the installed graph, the package family included, passes the gate and prints its volume", async () => {
    const result = await runGate(REVIEW_DIR);
    expect(result.exitCode).toBe(0);
    const volume = /(\d+) installed dependenc(?:y|ies) audited against (\d+) allowed licence/.exec(
      result.output,
    );
    expect(volume, result.output).not.toBeNull();
    // 37 on the day this was written; the floor is "the family is in there".
    expect(Number(volume?.[1])).toBeGreaterThan(30);
  });

  test("the package family is part of what was audited, under MIT", async () => {
    for (const name of [
      "@langchain/langgraph",
      "@langchain/core",
      "@langchain/langgraph-checkpoint",
    ]) {
      const installed = await Bun.file(
        join(REVIEW_DIR, "node_modules", name, "package.json"),
      ).json();
      expect(installed.license, name).toBe("MIT");
    }
  });

  test("a licence outside the admitted list fails the gate and names the package", async () => {
    const dir = await copyOfInstall({
      "fine-package": "MIT",
      "copyleft-package": "GPL-3.0-only",
    });
    const result = await runGate(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("copyleft-package@1.0.0");
    expect(result.output).toContain("GPL-3.0-only");
  });

  test("the same copy without the foreign licence passes", async () => {
    const dir = await copyOfInstall({ "fine-package": "MIT", "other-package": "Apache-2.0" });
    const result = await runGate(dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("2 installed dependencies audited");
  });

  test("an empty install is an audit of nothing, and fails", async () => {
    const dir = await copyOfInstall({});
    const result = await runGate(dir);
    expect(result.exitCode).not.toBe(0);
  });
});
