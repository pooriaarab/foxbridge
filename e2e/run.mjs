// The E2E test. It installs the real host manifest for the current user
// (and puts back what was there after), starts Firefox with the built
// extension, and connects a real MCP client to `foxbridge mcp` over stdio.
// The test plays the user: it turns the bridge on and shares tabs in the
// real sidebar. It writes artifacts/e2e-<date>.json.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary);
// FOXBRIDGE_SHOTS=<dir> also saves the sidebar state as JSON, for screenshots.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { launch, poll, serve, writeArtifact } from "create-foxkit/e2e";
import { FrameReader, LIMITS, encodeFrame, manifestDir } from "../dist/index.js";

const record = { startedAt: new Date().toISOString(), checks: [], calls: {} };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: JSON.stringify(actual) === JSON.stringify(expected) });
const cli = (...args) => execFileSync(process.execPath, ["dist/cli.js", ...args], { encoding: "utf8" });

// The socket lives in a temp folder, so a real foxbridge setup is not touched.
const work = mkdtempSync(join(tmpdir(), "fbr-e2e-"));
process.env.FOXBRIDGE_SOCKET = join(work, "host.sock");
const manifestPath = join(manifestDir(), "foxbridge.json");
const launcherPath = join(homedir(), ".foxbridge", process.platform === "win32" ? "foxbridge-host.cmd" : "foxbridge-host");
const launcherDir = join(homedir(), ".foxbridge");
const freshDirs = [manifestDir(), launcherDir].filter((dir) => !existsSync(dir));
const saved = [manifestPath, launcherPath].filter(existsSync).map((file, i) => {
  const copy = join(work, `saved-${i}`);
  copyFileSync(file, copy);
  return { file, copy };
});

/** One MCP client on `foxbridge mcp`. */
async function mcp() {
  const client = new Client({ name: "foxbridge-e2e", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/cli.js", "mcp"], env: { ...process.env }, stderr: "ignore" }));
  return {
    client,
    async call(name, args = {}, label = name) {
      const started = Date.now();
      const result = await client.callTool({ name, arguments: args });
      const out = { isError: result.isError === true, texts: result.content.map((c) => c.text), ms: Date.now() - started };
      record.calls[label] = { args: JSON.stringify(args).slice(0, 200), isError: out.isError, texts: out.texts.map((t) => t.slice(0, 600)), ms: out.ms };
      return out;
    },
  };
}

const site = await serve("e2e/site");
const port = new URL(site.url).port;
let fox;
let lastState = async () => undefined;
const clients = [];
try {
  cli("install");
  fox = await launch({ extension: "dist-ext", headless: !process.argv.includes("--headed") });
  record.firefox = await fox.browser.version();
  const sidebar = await fox.openExtensionPage("sidebar.html");
  const state = () => sidebar.evaluate(() => browser.runtime.sendMessage({ op: "state" }));
  lastState = state;
  const click = (selector) => sidebar.evaluate((s) => document.querySelector(s).click(), selector);
  /** Ticks the Share box of a tab in the sidebar, as the user does. */
  async function shareTab(tabId) {
    await poll(sidebar, (id) => Boolean(document.querySelector(`input.share[data-tab="${id}"]`)), tabId, 10_000);
    await sidebar.evaluate((id) => document.querySelector(`input.share[data-tab="${id}"]`).click(), tabId);
    await poll(sidebar, (id) => document.querySelector(`input.share[data-tab="${id}"]`)?.checked, tabId);
  }

  // H4: an agent with the bridge off.
  const early = await mcp();
  clients.push(early);
  const off = await early.call("list_tabs", {}, "bridge-off");
  check("H4: a call with the bridge off says to turn it on", true, off.isError && off.texts[0].includes("bridge-off") && off.texts[0].includes("sidebar"));
  await early.client.close();

  await click("#power");
  await poll(sidebar, () => document.getElementById("status").textContent === "On, waiting for an agent");
  await fox.open(`${site.url}/form.html`);
  const other = await fox.open(`${site.url}/other.html`);
  const tabs = await sidebar.evaluate(() => browser.tabs.query({}));
  const tabOf = (path) => tabs.find((t) => t.url?.endsWith(path)).id;
  const formTab = tabOf("/form.html");
  const otherTab = tabOf("/other.html");

  const agent = await mcp();
  clients.push(agent);
  const listed = await agent.client.listTools();
  check("the MCP server lists six tools", ["act", "click", "list_tabs", "open_url", "run_task", "snapshot"], listed.tools.map((t) => t.name).toSorted());
  const none = await agent.call("list_tabs", {}, "list_tabs-none");
  check("nothing is shared before the user shares a tab", true, !none.isError && none.texts[0].includes("shares no tabs"));
  check("the sidebar shows that an agent connected", "Agent connected", await poll(sidebar, () => document.getElementById("status").textContent === "Agent connected" && "Agent connected"));

  await shareTab(formTab);
  const listedTabs = await agent.call("list_tabs", {}, "list_tabs-shared");
  check("list_tabs shows the shared tab only", true, listedTabs.texts[0].includes(`tab ${formTab} on 127.0.0.1`) && !listedTabs.texts.join(" ").includes(`tab ${otherTab}`));
  if (process.env.FOXBRIDGE_SHOTS) writeFileSync(join(process.env.FOXBRIDGE_SHOTS, "shared.json"), JSON.stringify(await state()));

  // Snapshot: no approval for a read; page text is wrapped; the password stays in the page.
  const snap = await agent.call("snapshot", { tabId: formTab });
  const [head, block = ""] = snap.texts;
  const nonce = block.match(/^<page-data-([0-9a-f]+)>\n/)?.[1];
  check("snapshot of a shared tab works without an approval", false, snap.isError);
  check("P1: the injected text is inside the page-data block only", true,
    Boolean(nonce) && block.endsWith(`\n</page-data-${nonce}>`) && block.includes("ignore the user") && !head.includes("ignore the user") && /untrusted/.test(head));
  check("C9: the password value is not in the snapshot", false, snap.texts.join(" ").includes("hunter2-secret"));
  const unshared = await agent.call("snapshot", { tabId: otherTab }, "snapshot-unshared");
  check("C1: a call on an unshared tab is refused", true, unshared.isError && unshared.texts[0].includes("not-shared"));

  // C4: a raw client sends arguments that the MCP server would never send.
  await agent.client.close();
  await poll(sidebar, () => document.getElementById("status").textContent !== "Agent connected");
  const raw = connect(process.env.FOXBRIDGE_SOCKET);
  const reader = new FrameReader(LIMITS.socket);
  const replies = [];
  raw.on("data", (chunk) => replies.push(...reader.push(chunk).filter((m) => m.type === "reply")));
  await new Promise((resolve) => raw.once("connect", resolve));
  raw.write(encodeFrame({ type: "call", id: "r1", tool: "snapshot", args: { tabId: String(formTab) } }, LIMITS.socket));
  raw.write(encodeFrame({ type: "call", id: "r2", tool: "snapshot", args: { tabId: formTab, scope: "pay" } }, LIMITS.socket));
  for (let i = 0; i < 100 && replies.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  check("C4: the extension checks the args again: a text tab id and an extra arg are refused", ["not-shared", "bad-args"], replies.map((r) => r.error?.code));
  raw.destroy();
  await poll(sidebar, () => document.getElementById("status").textContent !== "Agent connected");
  const again = await mcp();
  clients.push(again);

  // C2: a shared tab moves to another site.
  await shareTab(otherTab);
  await other.goto(`http://localhost:${port}/other.html`);
  const moved = await again.call("snapshot", { tabId: otherTab }, "snapshot-moved");
  check("C2: a shared tab that moved to another site is no longer shared", true, moved.isError && moved.texts[0].includes("not-shared"));

  // C3: the kill switch.
  await click("#stop");
  const after = await again.call("list_tabs", {}, "after-kill");
  check("C3: after the kill switch, calls get host-gone or bridge-off", true, after.isError && /host-gone|bridge-off/.test(after.texts[0]));
  const next = await again.call("list_tabs", {}, "after-kill-again");
  check("after the kill switch, the next call gets bridge-off", true, next.isError && next.texts[0].includes("bridge-off"));
  const end = await state();
  check("after the kill switch, the bridge is off and no tab is shared", { on: false, shared: 0 }, { on: end.on, shared: end.tabs.filter((t) => t.shared).length });
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  record.stateAtError = await lastState().catch(() => undefined);
} finally {
  for (const c of clients) await c.client.close().catch(() => undefined);
  await fox?.close();
  await site.close();
  cli("uninstall");
  for (const { file, copy } of saved) {
    mkdirSync(join(file, ".."), { recursive: true });
    copyFileSync(copy, file);
    chmodSync(file, 0o755);
  }
  for (const dir of freshDirs) if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  rmSync(work, { recursive: true, force: true });
}
record.passed = !record.error && record.checks.length > 0 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}${c.ok ? "" : `: ${JSON.stringify(c.actual)}`}`);
console.log(`${record.passed ? "PASS" : "FAIL"}, ${record.checks.filter((c) => c.ok).length}/${record.checks.length} checks${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
