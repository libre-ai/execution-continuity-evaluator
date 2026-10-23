import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { HERE, mutantOf, spawnClean } from "./harness";

describe("the proof harness", () => {
  test("the child environment is built from nothing", () => {
    process.env.AMBIENT_PROBE = "inherited";
    const run = spawnClean([
      process.execPath,
      "-e",
      "console.log(Object.keys(process.env).sort().join(','))",
    ]);
    delete process.env.AMBIENT_PROBE;
    expect(run.exit).toBe(0);
    expect(run.out.trim()).toBe("HOME,PATH");
  });

  test("a mutation that matches nowhere, twice, or changes nothing is refused", () => {
    const gate = join(HERE, "check-langsmith-env.ts");
    expect(() => mutantOf(gate, "no such text anywhere", "x")).toThrow();
    expect(() => mutantOf(gate, "const", "let")).toThrow();
    expect(() => mutantOf(gate, "scanned += 1;", "scanned += 1;")).toThrow();
  });
});
