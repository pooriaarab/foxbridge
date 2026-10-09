// W1-W4 in docs/failure-modes.md: the length-prefixed JSON frames that
// Firefox native messaging uses, and that the host socket reuses.
import { endianness } from "node:os";
import { describe, expect, it } from "vitest";
import { FoxbridgeError, FrameReader, LIMITS, encodeFrame } from "../src/index.js";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof FoxbridgeError ? error.code : `not a FoxbridgeError: ${String(error)}`;
  }
  return "no error";
};

describe("frames", () => {
  it("writes a 4-byte length in native byte order, then UTF-8 JSON", () => {
    const frame = encodeFrame({ text: "é" }, LIMITS.toExtension);
    const body = Buffer.from(JSON.stringify({ text: "é" }), "utf8");
    const length = endianness() === "LE" ? frame.readUInt32LE(0) : frame.readUInt32BE(0);
    expect(length).toBe(body.length);
    expect(frame.subarray(4).equals(body)).toBe(true);
  });

  it("W1: refuses to write a body over the limit, and writes one at the limit", () => {
    const limit = 1000;
    const fits = "x".repeat(limit - 2); // the quotes make it 1000 bytes
    expect(encodeFrame(fits, limit).length).toBe(limit + 4);
    expect(codeOf(() => encodeFrame(`${fits}x`, limit))).toBe("too-large");
  });

  it("W1: the limit to the extension is 1 MB, as in Firefox", () => {
    expect(LIMITS.toExtension).toBe(1024 * 1024);
  });

  it("W4: reads a frame that arrives one byte at a time", () => {
    const reader = new FrameReader(LIMITS.socket);
    const frame = encodeFrame({ id: "a", n: 1 }, LIMITS.socket);
    const seen: unknown[] = [];
    for (const byte of frame) seen.push(...reader.push(Uint8Array.of(byte)));
    expect(seen).toEqual([{ id: "a", n: 1 }]);
  });

  it("W4: reads many frames from one chunk, in order", () => {
    const reader = new FrameReader(LIMITS.socket);
    const chunk = Buffer.concat([1, 2, 3].map((n) => encodeFrame({ n }, LIMITS.socket)));
    expect(reader.push(chunk)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(reader.push(Buffer.alloc(0))).toEqual([]);
  });

  it("W2: stops at a length header over the limit, before the body arrives", () => {
    const reader = new FrameReader(100);
    const header = Buffer.alloc(4);
    if (endianness() === "LE") header.writeUInt32LE(101);
    else header.writeUInt32BE(101);
    expect(codeOf(() => reader.push(header))).toBe("too-large");
  });

  it("W3: a body that is not JSON is a bad frame", () => {
    const reader = new FrameReader(100);
    const body = Buffer.from("{nope", "utf8");
    const header = Buffer.alloc(4);
    if (endianness() === "LE") header.writeUInt32LE(body.length);
    else header.writeUInt32BE(body.length);
    expect(codeOf(() => reader.push(Buffer.concat([header, body])))).toBe("bad-frame");
  });

  it("W6: reads an 8 MB frame that arrives in 1 KB chunks in under 1 s", () => {
    const reader = new FrameReader(LIMITS.socket);
    const frame = encodeFrame("x".repeat(LIMITS.socket - 2), LIMITS.socket);
    const started = Date.now();
    const seen: unknown[] = [];
    for (let at = 0; at < frame.length; at += 1024) seen.push(...reader.push(frame.subarray(at, at + 1024)));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen).toHaveLength(1);
    expect((seen[0] as string).length).toBe(LIMITS.socket - 2);
  });
});
