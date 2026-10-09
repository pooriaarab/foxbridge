// W1, H1, H2, H4, H9, T2 and T3 in docs/failure-modes.md: the MCP side of
// the host socket.
import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS, FoxbridgeError, LIMITS, MAX_APPROVAL_SECONDS, connectBridge } from "../src/index.js";
import { codeOf, paths, start, until } from "./helpers.js";

describe("bridge client", () => {
  it("sends a call and gets its answer", async () => {
    const { ext } = await start();
    const bridge = await connectBridge({ socketPath: paths.socket });
    const call = bridge.call("snapshot", { tabId: 3 });
    const sent = await ext.nextCall();
    expect(sent).toMatchObject({ type: "call", tool: "snapshot", args: { tabId: 3 } });
    ext.send({ type: "reply", id: sent.id, ok: true, result: { ok: true, summary: "read" } });
    expect(await call).toEqual({ ok: true, summary: "read" });
    bridge.close();
  });

  it("rejects with the code and the message from the extension", async () => {
    const { ext } = await start();
    const bridge = await connectBridge({ socketPath: paths.socket });
    const call = bridge.call("snapshot", { tabId: 3 });
    ext.send({ type: "reply", id: (await ext.nextCall()).id, ok: false, error: { code: "not-shared", message: "Tab 3 is not shared." } });
    expect(await call.catch((e: unknown) => e)).toMatchObject({ code: "not-shared", message: "Tab 3 is not shared." });
    bridge.close();
  });

  it("H4: fails at once with bridge-off when no host runs", async () => {
    const started = Date.now();
    const error = await connectBridge({ socketPath: paths.socket }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FoxbridgeError);
    expect((error as FoxbridgeError).code).toBe("bridge-off");
    expect((error as Error).message).toMatch(/sidebar/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("W1: refuses a call over 1 MB before it sends it", async () => {
    const { ext } = await start();
    const bridge = await connectBridge({ socketPath: paths.socket });
    expect(await codeOf(bridge.call("run_task", { tabId: 1, goal: "x".repeat(LIMITS.toExtension + 10) }))).toBe("too-large");
    expect(ext.calls()).toEqual([]);
    bridge.close();
  });

  it("H1: fails every waiting call at once when the host stops", async () => {
    const { ext } = await start();
    const bridge = await connectBridge({ socketPath: paths.socket, timeoutMs: 60_000 });
    const first = codeOf(bridge.call("list_tabs", {}));
    const second = codeOf(bridge.call("snapshot", { tabId: 1 }));
    await ext.nextCall(1);
    const started = Date.now();
    ext.end();
    expect([await first, await second]).toEqual(["host-gone", "host-gone"]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(bridge.closed).toBe(true);
    expect(await codeOf(bridge.call("list_tabs", {}))).toBe("host-gone");
  });

  it("H2: a second client gets busy, and the first keeps working", async () => {
    const { ext } = await start();
    const first = await connectBridge({ socketPath: paths.socket });
    expect(await codeOf(connectBridge({ socketPath: paths.socket }))).toBe("busy");
    const call = first.call("list_tabs", {});
    ext.send({ type: "reply", id: (await ext.nextCall()).id, ok: true, result: "still here" });
    expect(await call).toBe("still here");
    first.close();
  });

  it("H9: the extension hears when the agent disconnects", async () => {
    const { ext } = await start();
    const bridge = await connectBridge({ socketPath: paths.socket });
    void bridge.call("act", { tabId: 1 }).catch(() => undefined);
    await ext.nextCall();
    bridge.close();
    await until(() => ext.seen.find((m) => m.type === "agent" && m.connected === false));
  });

  it("T2: times out, sends cancel, and ignores a late answer", async () => {
    const { ext } = await start();
    const bridge = await connectBridge({ socketPath: paths.socket, timeoutMs: 100 });
    const call = codeOf(bridge.call("act", { tabId: 1 }));
    const { id } = await ext.nextCall();
    expect(await call).toBe("timeout");
    await until(() => ext.seen.find((m) => m.type === "cancel" && m.id === id));
    ext.send({ type: "reply", id, ok: true, result: "late" });
    const next = bridge.call("list_tabs", {});
    ext.send({ type: "reply", id: (await ext.nextCall(1)).id, ok: true, result: "next" });
    expect(await next).toBe("next");
    bridge.close();
  });

  it("T3: the default timeout is longer than the longest approval time", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(180_000);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(MAX_APPROVAL_SECONDS * 1000);
  });
});
