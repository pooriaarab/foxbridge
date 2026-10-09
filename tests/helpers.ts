// Test helpers: a host with a fake Firefox on two in-memory streams, and a
// raw socket client. The socket is real.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach } from "vitest";
import { FoxbridgeError, FrameReader, LIMITS, encodeFrame, runHost, type RunningHost } from "../src/index.js";

export type Msg = Record<string, unknown>;

export const paths = { dir: "", socket: "", secret: "" };
export const SECRET = "ab".repeat(32);
const running: RunningHost[] = [];
beforeEach(() => {
  paths.dir = mkdtempSync(join(tmpdir(), "fbr-"));
  paths.socket = join(paths.dir, "s", "host.sock");
  paths.secret = join(paths.dir, "secret");
  writeFileSync(paths.secret, SECRET, { mode: 0o600 });
  process.env.FOXBRIDGE_SECRET_FILE = paths.secret;
});
afterEach(async () => {
  for (const host of running.splice(0)) await host.close();
  rmSync(paths.dir, { recursive: true, force: true });
});

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

export const codeOf = (promise: Promise<unknown>) =>
  promise.then(() => "no error", (error) => (error instanceof FoxbridgeError ? error.code : `other: ${String(error)}`));

/** A fake Firefox: what the host writes to stdout, decoded, and a way to answer. */
export function fakeFirefox() {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = new FrameReader(LIMITS.toExtension);
  const seen: Msg[] = [];
  let stray = 0;
  output.on("data", (chunk: Buffer) => {
    try {
      seen.push(...(reader.push(chunk) as Msg[]));
    } catch {
      stray += 1;
    }
  });
  const calls = () => seen.filter((m) => m.type === "call");
  return {
    input,
    output,
    seen,
    stray: () => stray,
    send: (message: Msg) => input.write(encodeFrame(message, LIMITS.fromExtension)),
    calls,
    nextCall: (index = 0) => until(() => calls()[index]),
    end: () => input.end(),
  };
}

/** Starts a host on paths.socket with a fake Firefox. */
export async function start() {
  const ext = fakeFirefox();
  const host = await runHost({ input: ext.input, output: ext.output, socketPath: paths.socket, log: () => undefined });
  running.push(host);
  return { host, ext };
}

/** A socket client that speaks frames, for requests the MCP side never sends. */
export async function raw() {
  const socket = connect(paths.socket);
  await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  socket.write(encodeFrame({ type: "challenge", nonce: "00".repeat(32) }, LIMITS.socket));
  const reader = new FrameReader(LIMITS.socket);
  const seen: Msg[] = [];
  let closed = false;
  socket.on("data", (chunk: Buffer) => seen.push(...(reader.push(chunk) as Msg[])));
  socket.on("close", () => (closed = true));
  await until(() => seen.find((m) => m.type === "hello" || m.type === "refused"));
  return {
    socket,
    seen,
    closed: () => closed,
    send: (m: unknown) => socket.write(encodeFrame(m, LIMITS.socket)),
    reply: (id: string) => until(() => seen.find((m) => m.type === "reply" && m.id === id)),
  };
}
