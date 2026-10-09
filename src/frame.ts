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

/** Collects chunks and gives back whole messages. */
export class FrameReader {
  #buffer = Buffer.alloc(0);
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  /** Adds a chunk. Returns the messages it completes. Throws `too-large` or `bad-frame`. */
  push(chunk: Uint8Array): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const length = LE ? this.#buffer.readUInt32LE(0) : this.#buffer.readUInt32BE(0);
      if (length > this.#max) throw new FoxbridgeError("too-large", `A frame says ${length} bytes. The limit is ${this.#max} bytes.`);
      if (this.#buffer.length < 4 + length) break;
      const body = this.#buffer.subarray(4, 4 + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(4 + length);
      try {
        messages.push(JSON.parse(body));
      } catch {
        throw new FoxbridgeError("bad-frame", "A frame is not JSON.");
      }
    }
    return messages;
  }
}
