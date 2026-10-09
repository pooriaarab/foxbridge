// The native messaging host. Firefox starts it when the user turns on the
// bridge, and talks to it on stdin and stdout. It listens on a local
// socket for one MCP server at a time and passes calls and answers through.
// It never writes logs to stdout: stdout carries frames only.
import { chmod, mkdir, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { FrameReader, LIMITS, encodeFrame } from "./frame.js";
import { MESSAGES, type HostToAgent, type HostToExtension } from "./protocol.js";

export interface HostOptions {
  /** Messages from Firefox. Default in the CLI: stdin. */
  input: NodeJS.ReadableStream;
  /** Messages to Firefox. Default in the CLI: stdout. */
  output: NodeJS.WritableStream;
  socketPath: string;
  /** Default: stderr. */
  log?: (line: string) => void;
}

export interface RunningHost {
  /** Settles when the host has stopped. */
  closed: Promise<void>;
  close(): Promise<void>;
}

const isPipe = (path: string) => path.startsWith("\\\\");
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const goodId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64;

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** True when a host already answers on `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

function toAgent(socket: Socket, message: HostToAgent): void {
  try {
    socket.write(encodeFrame(message, LIMITS.socket));
  } catch (error) {
    if (message.type !== "reply") throw error;
    socket.write(encodeFrame({ type: "reply", id: message.id, ok: false, error: { code: "too-large", message: (error as Error).message } }, LIMITS.socket));
  }
}

const refuse = (socket: Socket, id: string, code: string, message: string) => toAgent(socket, { type: "reply", id, ok: false, error: { code, message } });

export async function runHost(o: HostOptions): Promise<RunningHost> {
  const log = o.log ?? ((line: string) => process.stderr.write(`foxbridge host: ${line}\n`));
  const sockets = new Set<Socket>();
  const pending = new Set<string>();
  let agent: Socket | undefined;
  let listening = false;
  let stopping: Promise<void> | undefined;
  let finished!: () => void;
  const closed = new Promise<void>((resolve) => (finished = resolve));

  const toExtension = (message: HostToExtension) => o.output.write(encodeFrame(message, LIMITS.toExtension));

  const server = createServer();
  const close = () =>
    (stopping ??= (async () => {
      for (const socket of sockets) socket.destroy();
      if (listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (!isPipe(o.socketPath)) await rm(o.socketPath, { force: true });
      }
      finished();
    })());

  const onAgentMessage = (socket: Socket, message: unknown) => {
    if (!isObject(message)) return;
    const { type, id, tool, args } = message;
    if (type === "cancel" && typeof id === "string" && pending.delete(id)) {
      toExtension({ type: "cancel", id });
      return;
    }
    if (type !== "call") return;
    if (!goodId(id)) {
      refuse(socket, typeof id === "string" ? id.slice(0, 64) : "", "bad-request", "A call needs an id of 1 to 64 characters.");
      return;
    }
    if (pending.has(id)) return refuse(socket, id, "bad-request", `A call with the id "${id}" is still waiting.`);
    if (typeof tool !== "string" || !tool || tool.length > 64 || !isObject(args)) return refuse(socket, id, "bad-request", "A call needs a tool name and an args object.");
    let frame: Buffer;
    try {
      frame = encodeFrame({ type: "call", id, tool, args }, LIMITS.toExtension);
    } catch (error) {
      return refuse(socket, id, "too-large", `${(error as Error).message} Firefox stops the host for a message over 1 MB.`);
    }
    pending.add(id);
    o.output.write(frame);
  };

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      sockets.delete(socket);
      if (agent !== socket) return;
      agent = undefined;
      pending.clear();
      if (!stopping) toExtension({ type: "agent", connected: false });
    });
    if (agent) {
      socket.end(encodeFrame({ type: "refused", code: "busy", message: MESSAGES.busy }, LIMITS.socket));
      return;
    }
    agent = socket;
    toAgent(socket, { type: "hello", version: 1 });
    toExtension({ type: "agent", connected: true });
    const reader = new FrameReader(LIMITS.socket);
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of reader.push(chunk)) onAgentMessage(socket, message);
      } catch (error) {
        log(`dropped the agent: ${(error as Error).message}`);
        socket.destroy();
      }
    });
  });

  const fromFirefox = new FrameReader(LIMITS.fromExtension);
  o.input.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = fromFirefox.push(chunk);
    } catch (error) {
      log(`stopping: ${(error as Error).message}`);
      void close();
      return;
    }
    for (const message of messages) {
      if (!isObject(message) || message.type !== "reply" || typeof message.id !== "string" || !pending.delete(message.id) || !agent) continue;
      const error = isObject(message.error) ? { code: String(message.error.code ?? "error"), message: String(message.error.message ?? "") } : undefined;
      toAgent(agent, { type: "reply", id: message.id, ok: message.ok === true, ...(message.ok === true ? { result: message.result } : { error: error ?? { code: "error", message: "The extension gave no reason." } }) });
    }
  });
  o.input.on("end", () => void close());
  o.input.on("error", () => void close());

  // A folder that the host makes gets mode 0700. FOXBRIDGE_SOCKET can name
  // a shared folder such as /tmp, so the socket file itself gets 0600.
  if (!isPipe(o.socketPath) && (await mkdir(dirname(o.socketPath), { recursive: true, mode: 0o700 }))) await chmod(dirname(o.socketPath), 0o700);
  try {
    await listen(server, o.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (await answers(o.socketPath)) {
      const message = `Another foxbridge host listens on ${o.socketPath}. Turn off the bridge in the other Firefox profile.`;
      log(message);
      toExtension({ type: "host-error", code: "socket-busy", message });
      await close();
      return { closed, close };
    }
    await rm(o.socketPath, { force: true });
    await listen(server, o.socketPath);
  }
  listening = true;
  if (!isPipe(o.socketPath)) await chmod(o.socketPath, 0o600);
  toExtension({ type: "ready" });
  return { closed, close };
}
