import { describe, expect, test } from "bun:test";
import { type WriteBytes, writeWhole } from "./fanout-run";

// A journal line is written in full or not at all silently: writeSync may
// write fewer bytes than asked, and its return value is the only sign of it.

/** A stand-in for writeSync that writes at most `chunk` bytes per call into `sink`. */
function shortWrites(chunk: number, sink: number[]): WriteBytes {
  return (_fd, buffer, offset, length) => {
    const count = Math.min(chunk, length);
    sink.push(...buffer.subarray(offset, offset + count));
    return count;
  };
}

const LINE = `${JSON.stringify({ type: "pass_start", role: "alpha", note: "é ✓" })}\n`;

describe("writeWhole", () => {
  test.each([1, 3, 7, 1000])("short writes of %d byte(s) still write the whole line", (chunk) => {
    const sink: number[] = [];
    writeWhole(42, LINE, shortWrites(chunk, sink));
    expect(Buffer.from(sink).toString("utf8")).toBe(LINE);
  });

  test("a write that makes no progress is an error, not a truncated line", () => {
    const sink: number[] = [];
    let calls = 0;
    const stalls: WriteBytes = (fd, buffer, offset, length) => {
      calls += 1;
      return calls === 1 ? shortWrites(5, sink)(fd, buffer, offset, length) : 0;
    };
    expect(() => writeWhole(42, LINE, stalls)).toThrow("journal write made no progress at byte 5");
  });

  test("the descriptor it was given is the one written to", () => {
    const seen: number[] = [];
    writeWhole(7, "x\n", (fd, _buffer, _offset, length) => {
      seen.push(fd);
      return length;
    });
    expect(seen).toEqual([7]);
  });
});
