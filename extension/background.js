// The foxbridge background (an MV3 event page). It owns the native port,
// foxgate, the shared tabs and the approvals. A call from an outside agent
// runs only on a tab that the user shares in the sidebar, and every change
// waits for the user there. The tools are foxloop's browser tool pack over
// foxpaw. The state lives only in memory: after a Firefox restart, the
// bridge is off and no tab is shared.
import { createFoxgate } from "foxgate";
import { browserTools, checkArgs, toolSpecs } from "foxloop";
import { DEFAULT_APPROVAL_SECONDS, MAX_APPROVAL_SECONDS, MIN_APPROVAL_SECONDS } from "../src/protocol.ts";

const HOST_NAME = "foxbridge";
/** MCP tool name -> foxloop browser tool name. */
const TAB_TOOLS = { snapshot: "snapshot", act: "act", click: "click", run_task: "browser_task" };
const OPEN_URL_SCHEMA = { type: "object", properties: { url: { type: "string", maxLength: 2000 } }, required: ["url"] };
const LOG_MAX = 100;

const state = {
  on: false,
  ready: false,
  agent: false,
  error: "",
  /** tabId -> { host, title, url } */
  shared: new Map(),
  /** foxgate request id -> { callId, tool, tabId, title, detail, text, expiresAt, finish } */
  pending: new Map(),
  log: [],
  settings: { approvalSeconds: DEFAULT_APPROVAL_SECONDS },
};
let port = null;
const packs = new Map();
const hostGrants = new Map();
const calls = new Map();
const { gate, host } = createFoxgate({ tools: { ...toolSpecs(browserTools({ tabId: () => 0 })), open_url: "read" } });

/** Runs a tool function that may return a value or a promise, as a promise. */
const later = (fn) => Promise.resolve().then(fn);
const refuse = (code, message) => Object.assign(new Error(message), { code });
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const hostOf = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : "";
  } catch {
    return "";
  }
};

function notify() {
  browser.runtime.sendMessage({ type: "changed" }).catch(() => undefined);
  browser.action.setBadgeText({ text: state.agent ? "AI" : state.on ? "on" : "" }).catch(() => undefined);
  browser.action.setBadgeBackgroundColor({ color: state.agent ? "#b45309" : "#2563eb" }).catch(() => undefined);
}

function log(text) {
  state.log.unshift({ at: Date.now(), text });
  state.log.length = Math.min(state.log.length, LOG_MAX);
  notify();
}

// ---- Sharing and grants ----

/** Reading a shared tab needs no approval. Changing it always does. */
function ensureGrants(site) {
  if (!hostGrants.has(site)) {
    hostGrants.set(site, Promise.all([
      host.addGrant({ scope: "read", domains: [site], tools: ["snapshot"], approval: "never" }),
      host.addGrant({ scope: "fill", domains: [site], tools: ["act"], approval: "always" }),
      host.addGrant({ scope: "submit", domains: [site], tools: ["click", "browser_task"], approval: "always" }),
    ]).then((grants) => grants.map((g) => g.id)));
  }
  return hostGrants.get(site);
}

async function dropGrants(site) {
  if ([...state.shared.values()].some((s) => s.host === site) || !hostGrants.has(site)) return;
  const ids = await hostGrants.get(site);
  hostGrants.delete(site);
  for (const id of ids) await host.revokeGrant(id);
}

async function share(tabId, info) {
  state.shared.set(tabId, info);
  packs.set(tabId, new Map(browserTools({ tabId: () => tabId }).map((t) => [t.name, t])));
  await ensureGrants(info.host);
  log(`Shared tab ${tabId} (${info.host}).`);
}

function unshare(tabId, why = "") {
  const shared = state.shared.get(tabId);
  if (!shared) return;
  state.shared.delete(tabId);
  packs.delete(tabId);
  for (const [id, p] of state.pending) if (p.tabId === tabId) finishApproval(id, "cancelled");
  void dropGrants(shared.host);
  log(why || `Stopped sharing tab ${tabId}.`);
}

// ---- Approvals ----

function finishApproval(requestId, answer) {
  const pending = state.pending.get(requestId);
  if (!pending) return;
  state.pending.delete(requestId);
  pending.finish(answer);
  log(`${answer === "approve" ? "Approved" : answer === "deny" ? "Denied" : answer === "timeout" ? "Timed out" : "Cancelled"}: ${pending.detail}`);
}

function askHuman(requestId, callId, view, signal) {
  return new Promise((resolve) => {
    const ms = state.settings.approvalSeconds * 1000;
    const timer = setTimeout(() => finishApproval(requestId, "timeout"), ms);
    state.pending.set(requestId, { ...view, callId, expiresAt: Date.now() + ms, finish: (answer) => (clearTimeout(timer), resolve(answer)) });
    signal.addEventListener("abort", () => finishApproval(requestId, "cancelled"), { once: true });
    log(`Waiting for you: ${view.detail}`);
  });
}

const NOT_RUN = {
  deny: ["approval-denied", "The user denied this action. Nothing ran."],
  timeout: ["approval-timeout", "Nobody approved this action in time. Nothing ran."],
  cancelled: ["approval-cancelled", "The approval was cancelled: the agent left, the bridge stopped, or the tab is no longer shared. Nothing ran."],
};

/** Runs the action through foxgate. Returns the action foxgate judged, or throws. */
async function passGate(callId, action, view, signal) {
  const decision = await gate.check(action);
  if (decision.decision === "allow") return decision.action;
  if (decision.decision === "deny") throw refuse("denied", `foxgate said no (${decision.reason}): ${decision.message}`);
  const request = (await host.pending()).find((r) => r.id === decision.requestId);
  const answer = await askHuman(decision.requestId, callId, { ...view, text: request?.text ?? "" }, signal);
  if (answer !== "approve") {
    await host.reject(decision.requestId).catch(() => undefined);
    throw refuse(...NOT_RUN[answer]);
  }
  const redeemed = await gate.redeem(await host.approve(decision.requestId), action);
  if (redeemed.decision !== "allow") throw refuse("denied", `foxgate said no after the approval (${redeemed.reason}).`);
  return redeemed.action;
}

// ---- Tools ----

async function listTabs() {
  const tabs = [];
  for (const [tabId, s] of state.shared) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (tab) tabs.push({ tabId, host: s.host, title: tab.title ?? "", url: tab.url ?? "" });
  }
  if (!tabs.length) return { ok: true, summary: "The user shares no tabs. Ask the user to share a tab in the foxbridge sidebar." };
  return {
    ok: true,
    summary: `${tabs.length} shared tab${tabs.length === 1 ? "" : "s"}: ${tabs.map((t) => `tab ${t.tabId} on ${t.host}`).join(", ")}.`,
    untrusted: tabs.map((t) => `tab ${t.tabId}: ${t.title} (${t.url})`).join("\n"),
  };
}

async function openUrl(callId, args, signal) {
  const bad = checkArgs(OPEN_URL_SCHEMA, args);
  if (bad) throw refuse("bad-args", `The args do not fit open_url: ${bad}.`);
  const site = hostOf(args.url);
  if (!site) throw refuse("bad-args", "open_url opens only http: and https: addresses.");
  const url = new URL(args.url).href;
  const grant = await host.addGrant({ scope: "read", domains: [site], tools: ["open_url"], approval: "always", maxUses: 1 });
  try {
    const action = await passGate(callId, { tool: "open_url", args: { url }, domain: site, scope: "read" }, { tool: "open_url", tabId: null, title: "", detail: `open ${url} in a new tab and share it` }, signal);
    const tab = await browser.tabs.create({ url: action.args.url, active: false });
    await share(tab.id, { host: site, title: url, url });
    return { ok: true, summary: `Opened the address in tab ${tab.id}. The tab is shared. Call snapshot when it has loaded.` };
  } finally {
    await host.revokeGrant(grant.id);
  }
}

async function runCall(callId, tool, args, signal) {
  if (!isObject(args)) throw refuse("bad-args", "The args must be an object.");
  if (tool === "list_tabs") return listTabs();
  if (tool === "open_url") return openUrl(callId, args, signal);
  const name = TAB_TOOLS[tool];
  if (!name) throw refuse("unknown-tool", `foxbridge has no tool "${tool}".`);
  const { tabId, ...rest } = args;
  const shared = Number.isInteger(tabId) ? state.shared.get(tabId) : undefined;
  if (!shared) throw refuse("not-shared", `Tab ${String(tabId)} is not shared. Ask the user to share it in the foxbridge sidebar.`);
  const t = packs.get(tabId).get(name);
  const bad = checkArgs(t.parameters, rest);
  if (bad) throw refuse("bad-args", `The args do not fit ${tool}: ${bad}.`);
  const ctx = { signal, step: 1, goal: `outside agent: ${tool}` };
  // prepare pins the exact control into the action that foxgate judges and the human approves.
  const prepared = t.prepare ? await later(() => t.prepare(rest, ctx)).catch((error) => {
    throw refuse("bad-args", `${error.message} Call snapshot first.`);
  }) : rest;
  const site = await later(() => t.domain(prepared, ctx)).catch(() => "");
  if (site !== shared.host) {
    unshare(tabId, `Tab ${tabId} left ${shared.host}, so sharing stopped.`);
    throw refuse("not-shared", `Tab ${tabId} left ${shared.host}, so sharing stopped. Ask the user to share it again.`);
  }
  let detail = tool === "snapshot" ? `read the page "${shared.title}"` : `run foxpaw on "${shared.title}" with the goal "${rest.goal}"`;
  if (t.describe) detail = await later(() => t.describe(prepared, { ...ctx, domain: site })).catch((error) => {
    throw refuse("bad-args", `${error.message} Call snapshot first.`);
  });
  const action = await passGate(callId, { tool: name, args: prepared, domain: site, scope: t.scope }, { tool, tabId, title: shared.title, detail }, signal);
  const out = await t.run(action.args, { ...ctx, domain: action.domain });
  log(`${tool} on tab ${tabId}: ${out.ok ? "done" : "not done"}.`);
  return { ok: out.ok, summary: out.summary, ...(out.untrusted ? { untrusted: out.untrusted } : {}) };
}

async function handleCall(p, { id, tool, args }) {
  const controller = new AbortController();
  calls.set(id, controller);
  let reply;
  try {
    reply = { type: "reply", id, ok: true, result: await runCall(id, tool, args, controller.signal) };
  } catch (error) {
    const code = error?.code ?? "error";
    reply = { type: "reply", id, ok: false, error: { code, message: error?.message ?? String(error) } };
    log(`Refused ${tool} (${code}).`);
  } finally {
    calls.delete(id);
  }
  // A native port, not a window: there is no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  if (port === p) p.postMessage(reply);
}

// ---- The native port ----

function stopBridge(error, disconnect) {
  const p = port;
  port = null;
  if (disconnect) p?.disconnect();
  Object.assign(state, { on: false, ready: false, agent: false, error });
  for (const id of state.pending.keys()) finishApproval(id, "cancelled");
  for (const c of calls.values()) c.abort();
  log(error || "Bridge off.");
}

/**
 * Firefox sometimes fails to start a native app with "An unexpected error
 * occurred" (we saw 2 of 12 starts fail on macOS). Try a start 3 times.
 */
const START_TRIES = 3;

function turnOn(attempt = 1) {
  if (port) return;
  Object.assign(state, { on: true, ready: false, error: "" });
  const p = browser.runtime.connectNative(HOST_NAME);
  port = p;
  p.onMessage.addListener((m) => {
    if (port !== p || !isObject(m)) return;
    if (m.type === "ready") {
      state.ready = true;
      log("Bridge on. Waiting for an agent.");
    } else if (m.type === "agent") {
      state.agent = m.connected === true;
      if (!state.agent) for (const c of calls.values()) c.abort();
      log(state.agent ? "An agent connected." : "The agent disconnected.");
    } else if (m.type === "host-error") {
      state.error = String(m.message);
      log(state.error);
    } else if (m.type === "call" && typeof m.id === "string") {
      void handleCall(p, m);
    } else if (m.type === "cancel") {
      calls.get(m.id)?.abort();
    }
  });
  p.onDisconnect.addListener(() => {
    if (port !== p) return;
    const why = p.error?.message ?? "";
    if (!state.ready && why === "An unexpected error occurred" && attempt < START_TRIES) {
      port = null;
      log(`Firefox could not start the host. Trying again (${attempt + 1} of ${START_TRIES}).`);
      setTimeout(() => state.on && turnOn(attempt + 1), 250);
      return;
    }
    stopBridge(state.ready
      ? `The host stopped${why ? `: ${why}` : "."}`
      : `Firefox could not start the foxbridge host${why ? ` (${why})` : ""}. Run "foxbridge install" in a terminal, then turn the bridge on again.`, false);
  });
  if (attempt === 1) log("Starting the foxbridge host.");
}

/** Turn off and the kill switch: close the port, deny what waits, and stop sharing every tab. */
function stopNow() {
  stopBridge("", true);
  for (const tabId of state.shared.keys()) unshare(tabId);
  log("Stopped. The bridge is off and no tab is shared.");
}

// ---- Sidebar messages and tab events ----

async function sidebarView() {
  const all = await browser.tabs.query({});
  return {
    on: state.on, ready: state.ready, agent: state.agent, error: state.error, settings: state.settings, log: state.log,
    tabs: all.filter((t) => hostOf(t.url)).map((t) => ({ tabId: t.id, title: t.title ?? "", host: hostOf(t.url), shared: state.shared.has(t.id) })),
    pending: [...state.pending].map(([requestId, p]) => ({ requestId, tool: p.tool, tabId: p.tabId, title: p.title, detail: p.detail, text: p.text, expiresAt: p.expiresAt })),
  };
}

async function onSidebar(m) {
  if (m.op === "on") turnOn();
  else if (m.op === "off") stopNow();
  else if (m.op === "answer") finishApproval(m.requestId, m.answer === "approve" ? "approve" : "deny");
  else if (m.op === "settings") {
    const seconds = Math.round(Number(m.approvalSeconds));
    if (seconds >= MIN_APPROVAL_SECONDS && seconds <= MAX_APPROVAL_SECONDS) {
      state.settings.approvalSeconds = seconds;
      await browser.storage.local.set({ settings: state.settings });
    }
  }
  else if (m.op === "share") {
    if (!m.on) unshare(m.tabId);
    else {
      const tab = await browser.tabs.get(m.tabId);
      const site = hostOf(tab.url);
      if (site) await share(tab.id, { host: site, title: tab.title ?? "", url: tab.url });
    }
  }
  return sidebarView();
}

const loaded = browser.storage.local.get("settings").then(({ settings }) => {
  if (settings) state.settings = { ...state.settings, ...settings };
});

browser.runtime.onMessage.addListener((m) => (isObject(m) && typeof m.op === "string" ? loaded.then(() => (m.op === "state" ? sidebarView() : onSidebar(m))) : undefined));
browser.action.onClicked.addListener(() => browser.sidebarAction.open());
browser.tabs.onRemoved.addListener((tabId) => unshare(tabId, `Tab ${tabId} closed, so sharing stopped.`));
browser.tabs.onUpdated.addListener((tabId, change) => {
  const shared = state.shared.get(tabId);
  if (shared && change.url && change.url !== "about:blank" && hostOf(change.url) !== shared.host) unshare(tabId, `Tab ${tabId} left ${shared.host}, so sharing stopped.`);
  else if (shared && change.title) shared.title = change.title;
  if (change.status === "complete" || change.title) notify();
});
browser.tabs.onCreated.addListener(() => notify());
