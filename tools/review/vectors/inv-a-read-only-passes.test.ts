import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { buildPassArgv, parsePlan } from "../fanout-core";
import {
  DRIVERS,
  disposeFixture,
  type Fixture,
  makeFixture,
  runRealCampaign,
  setFakePiReply,
} from "../fanout-fixtures";

// Vector 2 of ADR-0045 for INV-a (CA-26): no untrusted string in front of a
// model that holds a write, execute or network tool. A review pass reads the
// commit under review and the evidence, both untrusted, so every model the
// orchestrator starts must hold read-only tools; then no privileged prompt
// exists, and no output of a pass is handed to a second model.
//
// The command line of each pass is captured by a stand-in `pi` named by path
// (`OpenOptions.piBinary`), which records its argv and its prompt.

setDefaultTimeout(30000);

// The read-only profile CA-26 names, written from the clause and not from the
// code under test: `pi --tools read,grep,find,ls --no-mcp`.
const READ_ONLY_TOOLS = ["find", "grep", "ls", "read"];
// What closes the other sources of a tool on pi 1.4.0, each flag spelt as
// dist/cli/args.js matches it: an unknown long option is ignored, not refused.
const REQUIRED_FLAGS = ["--no-mcp", "--no-extensions", "--no-skills", "--no-approve"];
// Flags that would load code or trust the reviewed tree.
const FORBIDDEN_FLAGS = ["--approve", "-a", "--extension", "-e", "--skill", "--mode"];
// Tools of pi 1.4.0 whose access is write or execute (dist/core/tools), and the
// tools of its built-in extensions, which reach other tools.
const EFFECT_TOOLS = ["bash", "powershell", "edit", "write", "codemode", "tool_search"];

let started = 0;
let held = 0;
afterAll(() => {
  console.log(`vector 2 (INV-a, CA-26): ${started} case(s) exercised, ${held} held`);
});

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const created of fixtures.splice(0)) await disposeFixture(created);
});

/** The tool policy a command line gives pi, read the way pi 1.4.0 reads it. */
function expectReadOnlyProfile(argv: readonly string[]): void {
  const allowlists = argv.flatMap((arg, index) =>
    arg === "--tools" || arg === "-t" ? [argv[index + 1] ?? ""] : [],
  );
  expect(allowlists).toHaveLength(1);
  const tools = (allowlists[0] ?? "").split(",").map((tool) => tool.trim());
  expect([...tools].sort()).toEqual(READ_ONLY_TOOLS);
  for (const tool of tools) {
    expect(EFFECT_TOOLS).not.toContain(tool);
    // `+name` / `-name` edit the defaults instead of replacing them; a pattern
    // or an `mcp__` entry widens the set.
    expect(tool).not.toMatch(/^[+-]|\*|^mcp__/);
  }
  for (const flag of REQUIRED_FLAGS) expect(argv).toContain(flag);
  for (const flag of FORBIDDEN_FLAGS) expect(argv).not.toContain(flag);
}

function reply(marker: string): string {
  const verdict = {
    reviewPassId: "{{reviewPassId}}",
    role: "{{role}}",
    mode: "{{mode}}",
    commitSha: "{{commitSha}}",
    contractHashes: [],
    commands: ["git status"],
    findings: { blocking: [], major: [], minor: [], nonBlocking: [] },
    residualRisks: [],
    verdict: "approve",
  };
  return `${marker}-{{role}} review done\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``;
}

describe("vector 2: every review pass holds read-only tools", () => {
  test("the command line built for a pass carries the read-only profile", () => {
    started += 1;
    const plan = parsePlan({
      subject: "s",
      commit: "a".repeat(40),
      roles: ["security"],
      provider: "p",
      model: "m",
      outputDir: "out",
    });
    const argv = buildPassArgv(plan, "pi", "THE PROMPT");
    expect(argv[0]).toBe("pi");
    expect(argv.at(-1)).toBe("THE PROMPT");
    expect(argv).toContain("--print");
    expectReadOnlyProfile(argv.slice(1, -1));
    held += 1;
  });

  test.each(
    DRIVERS,
  )("%s driver: each pass, captured, carries the profile and no tool with an effect", async (driver) => {
    started += 1;
    const roles = ["alpha", "beta", "gamma"];
    const fixture = await makeFixture(roles);
    fixtures.push(fixture);
    await setFakePiReply(fixture, reply("PASS-OUTPUT"));
    const campaign = await runRealCampaign(fixture, driver, driver);

    expect(campaign.outcome.failed).toBe(0);
    expect(campaign.invocations).toHaveLength(roles.length);
    for (const invocation of campaign.invocations) {
      expectReadOnlyProfile(invocation.argv);
      // The model that holds them reads the reviewed content: the evidence
      // digest of the fixture commit is in its prompt.
      expect(invocation.prompt).toContain("subject.txt");
      expect(invocation.cwd).not.toBe(fixture.dir);
    }
    held += 1;
  });

  test.each(DRIVERS)("%s driver: no output of a pass reaches another model", async (driver) => {
    started += 1;
    const roles = ["alpha", "beta", "gamma", "delta"];
    const fixture = await makeFixture(roles);
    fixtures.push(fixture);
    await setFakePiReply(fixture, reply("PASS-OUTPUT"));
    const campaign = await runRealCampaign(fixture, driver, driver);

    // One model per pass and no other: nothing is summarised, re-ranked or
    // aggregated by a model.
    expect(campaign.invocations).toHaveLength(roles.length);
    expect(campaign.outcome.results.map((result) => result.ok)).toEqual(roles.map(() => true));
    for (const invocation of campaign.invocations) {
      expect(invocation.prompt).not.toContain("PASS-OUTPUT");
    }
    held += 1;
  });

  // That every spawned pass goes through it is what the captures above show.
  test("the command line of a pass is assembled in one source only", async () => {
    started += 1;
    const reviewDir = join(import.meta.dir, "..");
    const sources = readdirSync(reviewDir).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "fanout-fixtures.ts",
    );
    const declaring: string[] = [];
    for (const name of sources) {
      const text = await Bun.file(join(reviewDir, name)).text();
      if (text.includes('"--tools"') || text.includes('"--print"')) declaring.push(name);
    }
    expect(declaring).toEqual(["fanout-core.ts"]);
    held += 1;
  });
});
