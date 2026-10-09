// The native messaging host. Firefox starts it when the user turns on the
// bridge, and talks to it on stdin and stdout. It listens on a local
// socket for one MCP server at a time and passes calls and answers through.
// It never writes logs to stdout: stdout carries frames only.
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { basename, dirname } from "node:path";
import { FrameReader, LIMITS, encodeFrame } from "./frame.js";
import { MESSAGES, type HostToAgent, type HostToExtension } from "./protocol.js";
import { hostProof, readSecret } from "./secret.js";
import { defaultSecretPath } from "./socket.js";

/** How long a new client has to send its challenge. */
const CHALLENGE_MS = 5000;

export interface HostOptions {
  /** Messages from Firefox. Default in the CLI: stdin. */
  input: NodeJS.ReadableStream;
  /** Messages to Firefox. Default in the CLI: stdout. */
  output: NodeJS.WritableStream;
  socketPath: string;
  /** The secret file from `install`. Default: defaultSecretPath(). */
  secretPath?: string;
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

/** H15: listen with umask 077, so a socket file is made 0600 with no loose moment. */
async function listenPrivate(server: Server, path: string): Promise<void> {
  if (isPipe(path)) return listen(server, path);
  const before = process.umask(0o077);
  try {
    await listen(server, path);
  } finally {
    process.umask(before);
  }
}

/**
 * H14: the socket folder must be a real folder of this user with mode
 * 0700. A folder that this call makes, or a folder named .foxbridge, is
 * tightened to 0700. Returns why the folder is unsafe, or undefined.
 */
async function checkFolder(dir: string): Promise<string | undefined> {
  const made = await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) return `${dir} is not a real folder. foxbridge does not put its socket there.`;
  if (process.getuid && info.uid !== process.getuid()) return `${dir} belongs to another user. Set FOXBRIDGE_SOCKET to a path in a folder of your own with mode 0700.`;
  if ((info.mode & 0o077) === 0) return undefined;
  if (made || basename(dir) === ".foxbridge") {
    await chmod(dir, 0o700);
    return undefined;
  }
  return `Other users can open ${dir}. Run "chmod 700 ${dir}", or set FOXBRIDGE_SOCKET to a path in a folder of your own.`;
}

/** H16: takes the start lock. A lock of a dead process is removed. Returns false when a live host holds it. */
async function takeLock(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(path, "utf8").catch(() => ""));
      if (alive(pid)) return false;
      await rm(path, { force: true });
    }
  }
  return false;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function runHost(o: HostOptions): Promise<RunningHost> {
  const log = o.log ?? ((line: string) => process.stderr.write(`foxbridge host: ${line}\n`));
  const sockets = new Set<Socket>();
  const greetedSockets = new WeakSet<Socket>();
  const pending = new Set<string>();
  // H10: one call for a tab at a time. tabId -> the id in flight, and the
  // calls that wait for their tab, in the order the agent sent them.
  const busyTabs = new Map<number, string>();
  const queued: { id: string; tabId: number; frame: Buffer }[] = [];
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

  /** The call `id` ended: send the next call that waits for its tab. */
  const release = (id: string) => {
    for (const [tabId, current] of busyTabs) {
      if (current !== id) continue;
      busyTabs.delete(tabId);
      const at = queued.findIndex((q) => q.tabId === tabId);
      if (at < 0) continue;
      const [next] = queued.splice(at, 1);
      if (!next) continue;
      busyTabs.set(tabId, next.id);
      o.output.write(next.frame);
    }
  };

  const onAgentMessage = (socket: Socket, message: unknown) => {
    if (!isObject(message)) return;
    const { type, id, tool, args } = message;
    if (type === "cancel" && typeof id === "string" && pending.delete(id)) {
      const at = queued.findIndex((q) => q.id === id);
      if (at >= 0) queued.splice(at, 1);
      else {
        toExtension({ type: "cancel", id });
        release(id);
      }
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
    const tabId = Number.isInteger(args.tabId) ? (args.tabId as number) : undefined;
    if (tabId === undefined) {
      o.output.write(frame);
    } else if (busyTabs.has(tabId)) {
      queued.push({ id, tabId, frame });
    } else {
      busyTabs.set(tabId, id);
      o.output.write(frame);
    }
  };

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      sockets.delete(socket);
      if (agent !== socket) return;
      agent = undefined;
      pending.clear();
      busyTabs.clear();
      queued.length = 0;
      if (!stopping && greetedSockets.has(socket)) toExtension({ type: "agent", connected: false });
    });
    if (agent) {
      socket.end(encodeFrame({ type: "refused", code: "busy", message: MESSAGES.busy }, LIMITS.socket));
      return;
    }
    agent = socket;
    // H11: the first message must be a challenge. The host proves the secret in hello.
    let greeted = false;
    const timer = setTimeout(() => !greeted && socket.destroy(), CHALLENGE_MS);
    socket.on("close", () => clearTimeout(timer));
    const reader = new FrameReader(LIMITS.socket);
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of reader.push(chunk)) {
          if (greeted) {
            onAgentMessage(socket, message);
            continue;
          }
          const challenge = isObject(message) && message.type === "challenge" ? message.nonce : undefined;
          if (typeof challenge !== "string" || !/^[0-9a-f]{32,128}$/.test(challenge)) {
            socket.destroy();
            return;
          }
          greeted = true;
          greetedSockets.add(socket);
          clearTimeout(timer);
          toAgent(socket, { type: "hello", version: 1, proof: hostProof(secret, challenge) });
          toExtension({ type: "agent", connected: true });
        }
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
      const waiting = queued.findIndex((q) => q.id === message.id);
      if (waiting >= 0) queued.splice(waiting, 1);
      release(message.id);
      const error = isObject(message.error) ? { code: String(message.error.code ?? "error"), message: String(message.error.message ?? "") } : undefined;
      toAgent(agent, { type: "reply", id: message.id, ok: message.ok === true, ...(message.ok === true ? { result: message.result } : { error: error ?? { code: "error", message: "The extension gave no reason." } }) });
    }
  });
  o.input.on("end", () => void close());
  o.input.on("error", () => void close());

  let secret: Buffer;
  try {
    secret = await readSecret(o.secretPath ?? defaultSecretPath());
  } catch (error) {
    const message = (error as Error).message;
    log(message);
    toExtension({ type: "host-error", code: "no-secret", message });
    await close();
    return { closed, close };
  }

  const stop = async (code: string, message: string) => {
    log(message);
    toExtension({ type: "host-error", code, message });
    await close();
    return { closed, close };
  };
  if (!isPipe(o.socketPath)) {
    const unsafe = await checkFolder(dirname(o.socketPath));
    if (unsafe) return stop("unsafe-folder", unsafe);
  }
  const busy = `Another foxbridge host listens on ${o.socketPath}. Turn off the bridge in the other Firefox profile.`;
  try {
    await listenPrivate(server, o.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    // A Windows pipe name that another program holds: libuv's first instance uses FILE_FLAG_FIRST_PIPE_INSTANCE.
    if (isPipe(o.socketPath)) return stop("socket-busy", busy);
    // H16: remove a dead socket only under the lock, and check again there.
    const lock = await takeLock(`${o.socketPath}.lock`);
    if (!lock) return stop("socket-busy", busy);
    try {
      if (await answers(o.socketPath)) return stop("socket-busy", busy);
      await rm(o.socketPath, { force: true });
      try {
        await listenPrivate(server, o.socketPath);
      } catch (again) {
        if ((again as NodeJS.ErrnoException).code === "EADDRINUSE") return stop("socket-busy", busy);
        throw again;
      }
    } finally {
      await rm(`${o.socketPath}.lock`, { force: true });
    }
  }
  listening = true;
  // The umask made it 0700 already; 0600 drops the bit a socket does not use.
  if (!isPipe(o.socketPath)) await chmod(o.socketPath, 0o600);
  toExtension({ type: "ready" });
  return { closed, close };
}
