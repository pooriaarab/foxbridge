// The E2E test. It installs the real host manifest for the current user
// (and puts back what was there after), starts Firefox with the built
// extension, and connects a real MCP client to `foxbridge mcp` over stdio.
// The test plays the user: it turns the bridge on, shares tabs, and
// answers approvals in the real sidebar. It writes artifacts/e2e-<date>.json.
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
  /** Waits for the approval card, saves what it says, and clicks the answer. */
  async function answer(op) {
    const card = await poll(sidebar, () => {
      const li = document.querySelector("li.ask");
      return li && { detail: li.querySelector(".detail").textContent, text: li.querySelector("pre").textContent };
    }, undefined, 15_000);
    if (process.env.FOXBRIDGE_SHOTS && op === "approve") writeFileSync(join(process.env.FOXBRIDGE_SHOTS, "approval.json"), JSON.stringify(await state()));
    await click(`li.ask button[data-op="${op}"]`);
    return card;
  }

  // H4: an agent with the bridge off.
  const early = await mcp();
  clients.push(early);
  const off = await early.call("list_tabs", {}, "bridge-off");
  check("H4: a call with the bridge off says to turn it on", true, off.isError && off.texts[0].includes("bridge-off") && off.texts[0].includes("sidebar"));
  await early.client.close();

  await click("#power");
  await poll(sidebar, () => document.getElementById("status").textContent === "On, waiting for an agent");
  const form = await fox.open(`${site.url}/form.html`);
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
  const idOf = (label) => block.match(new RegExp(`\\[(\\d+:\\d+)\\] [a-z]+ "${label}"`))?.[1];
  const email = idOf("Email");
  const save = idOf("Save profile");

  // act with an approval through the sidebar.
  const acting = agent.call("act", { tabId: formTab, controlId: email, op: "type", value: "sam@example.com" }, "act-approved");
  const card = await answer("approve");
  const acted = await acting;
  check("act waits for the approval card, which names the field", true, card.detail.includes("sam@example.com") && card.detail.includes("Email") && card.text.includes('"tool":"act"'));
  check("act runs after the approval", false, acted.isError);
  check("the page field has the typed value", "sam@example.com", await form.evaluate(() => document.getElementById("email").value));

  // C6: the user denies a click.
  const clicking = agent.call("click", { tabId: formTab, controlId: save }, "click-denied");
  await answer("deny");
  const denied = await clicking;
  check("C6: a denied click is an error and nothing is sent", true, denied.isError && denied.texts[0].includes("approval-denied") && form.url().endsWith("/form.html"));

  const unshared = await agent.call("snapshot", { tabId: otherTab }, "snapshot-unshared");
  check("C1: a call on an unshared tab is refused", true, unshared.isError && unshared.texts[0].includes("not-shared"));
  const ghost = await agent.call("act", { tabId: formTab, controlId: "9:999", op: "type", value: "x" }, "act-unknown-control");
  check("C7: a control that is not in the snapshot is refused", true, ghost.isError && ghost.texts[0].includes("bad-args"));
  const js = await agent.call("open_url", { url: "javascript:alert(1)" }, "open_url-javascript");
  const file = await agent.call("open_url", { url: "file:///etc/passwd" }, "open_url-file");
  check("C5: open_url refuses javascript: and file:", true, js.isError && file.isError && js.texts[0].includes("bad-args") && file.texts[0].includes("bad-args"));
  check("no approval card showed for the refused calls", 0, (await state()).pending.length);

  // P3: the agent obeys the page and opens another site. The user still decides.
  const opening = agent.call("open_url", { url: `http://localhost:${port}/other.html` }, "open_url-denied");
  const openCard = await answer("deny");
  const openDenied = await opening;
  check("P3: open_url to another site waits for the user, who denies it", true, openCard.detail.includes(`localhost:${port}`) && openDenied.isError && openDenied.texts[0].includes("approval-denied"));

  const opened = agent.call("open_url", { url: `${site.url}/welcome.html` }, "open_url-approved");
  await answer("approve");
  const openedTab = Number((await opened).texts[0].match(/tab (\d+)/)?.[1]);
  const openedList = await agent.call("list_tabs", {}, "list_tabs-opened");
  check("open_url opens an approved address in a new shared tab", true, openedList.texts[0].includes(`tab ${openedTab} on 127.0.0.1`));

  // T1: nobody answers.
  await sidebar.evaluate(() => {
    const input = document.getElementById("seconds");
    input.value = "2";
    input.dispatchEvent(new Event("change"));
  });
  await poll(sidebar, () => document.getElementById("seconds").value === "2");
  const waited = await agent.call("act", { tabId: formTab, controlId: email, op: "type", value: "late" }, "act-timeout");
  check("T1: an approval nobody answers times out in about 2 s", true, waited.isError && waited.texts[0].includes("approval-timeout") && waited.ms >= 1900 && waited.ms < 6000);
  check("T1: the card is gone after the timeout", 0, (await state()).pending.length);
  await sidebar.evaluate(() => {
    const input = document.getElementById("seconds");
    input.value = "120";
    input.dispatchEvent(new Event("change"));
  });

  // run_task with an approval.
  const tasking = agent.call("run_task", { tabId: formTab, goal: "name: Sam Lee, plan Team, accept the terms" }, "run_task-approved");
  const taskCard = await answer("approve");
  const task = await tasking;
  check("run_task waits for the approval and foxpaw verifies the result", true, taskCard.detail.includes("Sam Lee") && !task.isError && task.texts[0].includes("verified: true"));
  await poll(form, () => location.pathname.endsWith("/welcome.html"));
  check("the form was sent to the same site, so the tab stays shared", true, form.url().includes("plan=team") && (await state()).tabs.some((t) => t.tabId === formTab && t.shared));


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

  // C3, H1: the kill switch while an approval waits.
  const pendingOpen = again.call("open_url", { url: `${site.url}/other.html` }, "kill-switch");
  await poll(sidebar, () => Boolean(document.querySelector("li.ask")), undefined, 15_000);
  await click("#stop");
  const killed = await pendingOpen;
  check("H1, C3: the kill switch ends the waiting call with host-gone", true, killed.isError && killed.texts[0].includes("host-gone") && killed.ms < 15_000);
  const after = await again.call("list_tabs", {}, "after-kill");
  check("after the kill switch, calls get bridge-off", true, after.isError && after.texts[0].includes("bridge-off"));
  const end = await state();
  check("after the kill switch, the bridge is off and no tab is shared", { on: false, shared: 0, pending: 0 }, { on: end.on, shared: end.tabs.filter((t) => t.shared).length, pending: end.pending.length });
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
