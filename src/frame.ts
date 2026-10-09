// Length-prefixed JSON, as Firefox native messaging sends it: a 32-bit
// length in native byte order, then that many bytes of UTF-8 JSON. The
// host socket uses the same frames.
import { endianness } from "node:os";
import { FoxbridgeError } from "./errors.js";

/** The largest JSON body, in bytes, for each link. */
export const LIMITS = {
  /** Firefox stops the host when one of its messages is over 1 MB. */
  toExtension: 1024 * 1024,
  /** Firefox allows 4 GB. foxbridge reads at most 8 MB. */
  fromExtension: 8 * 1024 * 1024,
  /** Between the MCP server and the host, in both directions. */
  socket: 8 * 1024 * 1024,
} as const;

const LE = endianness() === "LE";

/** One frame for `message`. Throws `too-large` when the JSON is over `max` bytes. */
export function encodeFrame(message: unknown, max: number): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > max) throw new FoxbridgeError("too-large", `The message is ${body.length} bytes. The limit is ${max} bytes.`);
  const header = Buffer.alloc(4);
  if (LE) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/**
 * Collects chunks and gives back whole messages. It keeps the chunks in a
 * list and joins them one time, when a whole frame is there (W6).
 */
export class FrameReader {
  #chunks: Buffer[] = [];
  #length = 0;
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  /** The first `n` bytes, joined. Joins the whole list only when the first chunk is too short. */
  #head(n: number): Buffer {
    const first = this.#chunks[0];
    if (first && first.length >= n) return first;
    const all = Buffer.concat(this.#chunks, this.#length);
    this.#chunks = [all];
    return all;
  }

  /** Adds a chunk. Returns the messages it completes. Throws `too-large` or `bad-frame`. */
  push(chunk: Uint8Array): unknown[] {
    if (chunk.length) {
      this.#chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
      this.#length += chunk.length;
    }
    const messages: unknown[] = [];
    while (this.#length >= 4) {
      const head = this.#head(4);
      const length = LE ? head.readUInt32LE(0) : head.readUInt32BE(0);
      if (length > this.#max) throw new FoxbridgeError("too-large", `A frame says ${length} bytes. The limit is ${this.#max} bytes.`);
      if (this.#length < 4 + length) break;
      const all = this.#head(4 + length);
      const body = all.subarray(4, 4 + length).toString("utf8");
      const rest = all.subarray(4 + length);
      this.#chunks = rest.length ? [rest] : [];
      this.#length = rest.length;
      try {
        messages.push(JSON.parse(body));
      } catch {
        throw new FoxbridgeError("bad-frame", "A frame is not JSON.");
      }
    }
    return messages;
  }
}
