// W1, W2, W5, H3 and H5-H8 in docs/failure-modes.md: the native messaging
// host, driven by a fake Firefox and raw socket clients.
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS, defaultSocketPath, encodeFrame, runHost } from "../src/index.js";
import { SECRET, fakeFirefox, paths, raw, sleep, start, until } from "./helpers.js";

describe("host", () => {
  it("W5: tells the extension it is ready, and writes nothing but frames to stdout", async () => {
    const { ext } = await start();
    await until(() => ext.seen.find((m) => m.type === "ready"));
    const client = await raw();
    expect(client.seen[0]).toEqual({ type: "hello", version: 1, proof: createHmac("sha256", Buffer.from(SECRET, "hex")).update(`foxbridge host proof v1:${"00".repeat(32)}`).digest("hex") });
    client.send({ type: "call", id: "a", tool: "list_tabs", args: {} });
    const call = await ext.nextCall();
    expect(call).toEqual({ type: "call", id: "a", tool: "list_tabs", args: {} });
    expect(ext.seen.findIndex((m) => m.type === "agent" && m.connected === true)).toBeLessThan(ext.seen.indexOf(call));
    ext.send({ type: "reply", id: "a", ok: true, result: { tabs: [] } });
    expect(await client.reply("a")).toEqual({ type: "reply", id: "a", ok: true, result: { tabs: [] } });
    ext.send({ type: "reply", id: "a2", ok: false });
    expect(ext.stray()).toBe(0);
    client.socket.destroy();
  });

  it("passes an error from the extension through with its code", async () => {
    const { ext } = await start();
    const client = await raw();
    client.send({ type: "call", id: "s", tool: "snapshot", args: { tabId: 3 } });
    await ext.nextCall();
    ext.send({ type: "reply", id: "s", ok: false, error: { code: "not-shared", message: "Tab 3 is not shared." } });
    expect(await client.reply("s")).toMatchObject({ ok: false, error: { code: "not-shared", message: "Tab 3 is not shared." } });
    client.socket.destroy();
  });

  it("W1: refuses a call over 1 MB, and keeps the port open", async () => {
    const { ext } = await start();
    const client = await raw();
    client.send({ type: "call", id: "big", tool: "run_task", args: { tabId: 1, goal: "x".repeat(LIMITS.toExtension + 10) } });
    expect(await client.reply("big")).toMatchObject({ ok: false, error: { code: "too-large" } });
    expect(ext.calls()).toEqual([]);
    client.send({ type: "call", id: "small", tool: "list_tabs", args: {} });
    expect(await ext.nextCall()).toMatchObject({ id: "small" });
    client.socket.destroy();
  });

  it("W2: drops a client whose length header is over the limit, then serves the next one", async () => {
    const { ext } = await start();
    const client = await raw();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(LIMITS.socket + 1);
    client.socket.write(header);
    await until(() => (client.closed() ? true : undefined));
    const next = await raw();
    next.send({ type: "call", id: "n", tool: "list_tabs", args: {} });
    expect(await ext.nextCall()).toMatchObject({ id: "n" });
    next.socket.destroy();
  });

  it("W2: stops when Firefox sends a length header over the limit", async () => {
    const { host, ext } = await start();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(LIMITS.fromExtension + 1);
    ext.input.write(header);
    await host.closed;
    expect(existsSync(paths.socket)).toBe(false);
  });

  it("H3: removes a socket file that nothing answers on, then listens", async () => {
    mkdirSync(dirname(paths.socket), { recursive: true });
    writeFileSync(paths.socket, "");
    const { ext } = await start();
    const client = await raw();
    client.send({ type: "call", id: "h3", tool: "list_tabs", args: {} });
    expect(await ext.nextCall()).toMatchObject({ id: "h3" });
    client.socket.destroy();
  });

  it("H3: a second host on a live socket tells its extension socket-busy and stops", async () => {
    await start();
    const second = fakeFirefox();
    const host = await runHost({ input: second.input, output: second.output, socketPath: paths.socket, log: () => undefined });
    await host.closed;
    expect(second.seen).toContainEqual(expect.objectContaining({ type: "host-error", code: "socket-busy" }));
    expect(existsSync(paths.socket)).toBe(true);
  });

  it("H5: stops, closes the socket and removes the file when Firefox closes the port", async () => {
    const { host, ext } = await start();
    expect(existsSync(paths.socket)).toBe(true);
    ext.end();
    await host.closed;
    expect(existsSync(paths.socket)).toBe(false);
    const refused = await new Promise((resolve) => connect(paths.socket).once("error", resolve).once("connect", () => resolve(null)));
    expect(refused).toBeInstanceOf(Error);
  });

  it("H6: drops an answer for an id that is not waiting", async () => {
    const { ext } = await start();
    const client = await raw();
    ext.send({ type: "reply", id: "nobody", ok: true, result: "stray" });
    client.send({ type: "call", id: "mine", tool: "list_tabs", args: {} });
    await ext.nextCall();
    ext.send({ type: "reply", id: "mine", ok: true, result: "mine" });
    await client.reply("mine");
    expect(client.seen.filter((m) => m.type === "reply")).toEqual([{ type: "reply", id: "mine", ok: true, result: "mine" }]);
    client.socket.destroy();
  });

  it.skipIf(process.platform === "win32")("H7: only the owner can reach the socket folder", async () => {
    await start();
    expect(statSync(dirname(paths.socket)).mode & 0o777).toBe(0o700);
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
  });

  it("H8: refuses a reused id or a bad request, and sends neither to the extension", async () => {
    const { ext } = await start();
    const client = await raw();
    client.send({ type: "call", id: "a", tool: "list_tabs", args: {} });
    await ext.nextCall();
    client.send({ type: "call", id: "a", tool: "list_tabs", args: {} });
    client.send({ type: "call", id: "b", args: {} });
    client.send({ type: "call", id: "x".repeat(65), tool: "list_tabs", args: {} });
    await until(() => (client.seen.filter((m) => m.type === "reply").length === 3 ? true : undefined));
    for (const reply of client.seen.filter((m) => m.type === "reply")) expect(reply).toMatchObject({ ok: false, error: { code: "bad-request" } });
    expect(ext.calls()).toHaveLength(1);
    client.socket.destroy();
  });
});

describe("host proof", () => {
  it("H11: drops a client whose first message is not a challenge, and sends nothing to the extension", async () => {
    const { ext } = await start();
    const socket = connect(paths.socket);
    await new Promise((resolve) => socket.once("connect", resolve));
    let closed = false;
    socket.on("close", () => (closed = true));
    socket.write(encodeFrame({ type: "call", id: "x", tool: "list_tabs", args: {} }, LIMITS.socket));
    await until(() => (closed ? true : undefined));
    expect(ext.calls()).toEqual([]);
    expect(ext.seen.some((m) => m.type === "agent")).toBe(false);
  });

  it("H13: with no secret file, tells the extension no-secret and stops", async () => {
    rmSync(paths.secret);
    const ff = fakeFirefox();
    const host = await runHost({ input: ff.input, output: ff.output, socketPath: paths.socket, log: () => undefined });
    await host.closed;
    expect(ff.seen).toContainEqual(expect.objectContaining({ type: "host-error", code: "no-secret" }));
    expect(String(ff.seen.find((m) => m.type === "host-error")?.message)).toContain("foxbridge install");
  });
});

describe("per-tab order", () => {
  it("H10: sends one call for a tab at a time, in order; other tabs and tab-less calls do not wait", async () => {
    const { ext } = await start();
    const client = await raw();
    client.send({ type: "call", id: "a", tool: "act", args: { tabId: 1, controlId: "0:1", op: "type", value: "x" } });
    client.send({ type: "call", id: "b", tool: "snapshot", args: { tabId: 1 } });
    client.send({ type: "call", id: "c", tool: "list_tabs", args: {} });
    client.send({ type: "call", id: "d", tool: "snapshot", args: { tabId: 2 } });
    await until(() => (ext.calls().length === 3 ? true : undefined));
    await sleep(50);
    expect(ext.calls().map((m) => m.id)).toEqual(["a", "c", "d"]);
    ext.send({ type: "reply", id: "a", ok: true, result: "acted" });
    expect(await ext.nextCall(3)).toMatchObject({ id: "b" });
    expect(await client.reply("a")).toMatchObject({ ok: true, result: "acted" });
    client.socket.destroy();
  });

  it("H10: a cancel drops a queued call, and an error answer frees the tab", async () => {
    const { ext } = await start();
    const client = await raw();
    client.send({ type: "call", id: "a", tool: "act", args: { tabId: 1 } });
    client.send({ type: "call", id: "b", tool: "snapshot", args: { tabId: 1 } });
    client.send({ type: "call", id: "c", tool: "click", args: { tabId: 1 } });
    await ext.nextCall();
    client.send({ type: "cancel", id: "b" });
    await sleep(20);
    ext.send({ type: "reply", id: "a", ok: false, error: { code: "approval-denied", message: "no" } });
    expect(await ext.nextCall(1)).toMatchObject({ id: "c" });
    expect(ext.calls().map((m) => m.id)).toEqual(["a", "c"]);
    client.socket.destroy();
  });

  it("H10: a cancel of the call in flight frees the tab", async () => {
    const { ext } = await start();
    const client = await raw();
    client.send({ type: "call", id: "a", tool: "act", args: { tabId: 1 } });
    client.send({ type: "call", id: "b", tool: "snapshot", args: { tabId: 1 } });
    await ext.nextCall();
    client.send({ type: "cancel", id: "a" });
    expect(await ext.nextCall(1)).toMatchObject({ id: "b" });
    expect(ext.seen.some((m) => m.type === "cancel" && m.id === "a")).toBe(true);
    client.socket.destroy();
  });
});

describe("socket path", () => {
  it("uses FOXBRIDGE_SOCKET, else a file in ~/.foxbridge, else a named pipe on Windows", () => {
    expect(defaultSocketPath({ FOXBRIDGE_SOCKET: "/tmp/x.sock" }, "linux", "/home/sam")).toBe("/tmp/x.sock");
    expect(defaultSocketPath({}, "darwin", "/Users/sam")).toBe("/Users/sam/.foxbridge/host.sock");
    expect(defaultSocketPath({ USERNAME: "sam" }, "win32", "C:\\Users\\sam")).toBe("\\\\.\\pipe\\foxbridge-sam");
  });
});
