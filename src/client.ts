// The MCP side of the host socket. One Bridge is one connection. A call
// waits for one answer, a timeout, or the end of the connection.
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { FoxbridgeError } from "./errors.js";
import { FrameReader, LIMITS, encodeFrame } from "./frame.js";
import { DEFAULT_TIMEOUT_MS, MESSAGES } from "./protocol.js";
import { defaultSocketPath } from "./socket.js";

export interface BridgeOptions {
  /** Default: defaultSocketPath(). */
  socketPath?: string;
  /** How long one call waits. Default: 180 s. */
  timeoutMs?: number;
}

export interface Bridge {
  /** Sends one call to the extension. Rejects with a FoxbridgeError. */
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  close(): void;
  readonly closed: boolean;
}

interface Waiting {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Connects to the host. Rejects with `bridge-off` when no host runs, or `busy`. */
export async function connectBridge(o: BridgeOptions = {}): Promise<Bridge> {
  const socketPath = o.socketPath ?? defaultSocketPath();
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = connect(socketPath);
  const waiting = new Map<string, Waiting>();
  const reader = new FrameReader(LIMITS.socket);
  let closed = false;
  let greet!: { resolve: () => void; reject: (error: Error) => void };
  const greeted = new Promise<void>((resolve, reject) => (greet = { resolve, reject }));

  socket.once("error", () => greet.reject(new FoxbridgeError("bridge-off", MESSAGES.bridgeOff)));
  socket.on("error", () => undefined);
  socket.on("close", () => {
    closed = true;
    greet.reject(new FoxbridgeError("host-gone", MESSAGES.hostGone));
    for (const [id, w] of waiting) {
      clearTimeout(w.timer);
      waiting.delete(id);
      w.reject(new FoxbridgeError("host-gone", MESSAGES.hostGone));
    }
  });
  socket.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = reader.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const raw of messages) {
      const m = raw as { type?: string; id?: string; ok?: boolean; result?: unknown; code?: string; message?: string; error?: { code?: string; message?: string } };
      if (m.type === "hello") greet.resolve();
      else if (m.type === "refused") greet.reject(new FoxbridgeError(m.code ?? "busy", m.message ?? MESSAGES.busy));
      else if (m.type === "reply" && typeof m.id === "string") {
        const w = waiting.get(m.id);
        if (!w) continue;
        waiting.delete(m.id);
        clearTimeout(w.timer);
        if (m.ok) w.resolve(m.result);
        else w.reject(new FoxbridgeError(m.error?.code ?? "error", m.error?.message ?? "The extension gave no reason."));
      }
    }
  });

  try {
    await greeted;
  } catch (error) {
    socket.destroy();
    throw error;
  }

  return {
    get closed() {
      return closed;
    },
    close: () => {
      socket.destroy();
    },
    call(tool, args) {
      if (closed) return Promise.reject(new FoxbridgeError("host-gone", MESSAGES.hostGone));
      const id = randomUUID();
      let frame: Buffer;
      try {
        frame = encodeFrame({ type: "call", id, tool, args }, LIMITS.toExtension);
      } catch (error) {
        return Promise.reject(new FoxbridgeError("too-large", `${(error as Error).message} Firefox takes at most 1 MB in one message.`));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          if (!closed) socket.write(encodeFrame({ type: "cancel", id }, LIMITS.socket));
          reject(new FoxbridgeError("timeout", `Firefox gave no answer in ${Math.round(timeoutMs / 1000)} s.`));
        }, timeoutMs);
        waiting.set(id, { resolve, reject, timer });
        socket.write(frame);
      });
    },
  };
}
