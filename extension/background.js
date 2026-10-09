// The foxbridge background (an MV3 event page). It owns the native port
// and the shared tabs. A call from an outside agent sees only the tabs
// that the user shares in the sidebar. The state lives only in memory:
// after a Firefox restart, the bridge is off and no tab is shared.

const HOST_NAME = "foxbridge";
const LOG_MAX = 100;

const state = {
  on: false,
  ready: false,
  agent: false,
  error: "",
  /** tabId -> { host, title, url } */
  shared: new Map(),
  log: [],
};
let port = null;

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

// ---- Sharing ----

async function share(tabId, info) {
  state.shared.set(tabId, info);
  log(`Shared tab ${tabId} (${info.host}).`);
}

function unshare(tabId, why = "") {
  if (!state.shared.delete(tabId)) return;
  log(why || `Stopped sharing tab ${tabId}.`);
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

async function runCall(tool, args) {
  if (!isObject(args)) throw refuse("bad-args", "The args must be an object.");
  if (tool === "list_tabs") return listTabs();
  throw refuse("unknown-tool", `This foxbridge extension does not run "${tool}" yet.`);
}

async function handleCall(p, { id, tool, args }) {
  let reply;
  try {
    reply = { type: "reply", id, ok: true, result: await runCall(tool, args) };
  } catch (error) {
    const code = error?.code ?? "error";
    reply = { type: "reply", id, ok: false, error: { code, message: error?.message ?? String(error) } };
    log(`Refused ${tool} (${code}).`);
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
      log(state.agent ? "An agent connected." : "The agent disconnected.");
    } else if (m.type === "host-error") {
      state.error = String(m.message);
      log(state.error);
    } else if (m.type === "call" && typeof m.id === "string") {
      void handleCall(p, m);
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

/** Turn off and the kill switch: close the port and stop sharing every tab. */
function stopNow() {
  stopBridge("", true);
  for (const tabId of state.shared.keys()) unshare(tabId);
  log("Stopped. The bridge is off and no tab is shared.");
}

// ---- Sidebar messages and tab events ----

async function sidebarView() {
  const all = await browser.tabs.query({});
  return {
    on: state.on, ready: state.ready, agent: state.agent, error: state.error, log: state.log,
    tabs: all.filter((t) => hostOf(t.url)).map((t) => ({ tabId: t.id, title: t.title ?? "", host: hostOf(t.url), shared: state.shared.has(t.id) })),
  };
}

async function onSidebar(m) {
  if (m.op === "on") turnOn();
  else if (m.op === "off") stopNow();
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

browser.runtime.onMessage.addListener((m) => (isObject(m) && typeof m.op === "string" ? (m.op === "state" ? sidebarView() : onSidebar(m)) : undefined));
browser.action.onClicked.addListener(() => browser.sidebarAction.open());
browser.tabs.onRemoved.addListener((tabId) => unshare(tabId, `Tab ${tabId} closed, so sharing stopped.`));
browser.tabs.onUpdated.addListener((tabId, change) => {
  const shared = state.shared.get(tabId);
  if (shared && change.url && change.url !== "about:blank" && hostOf(change.url) !== shared.host) unshare(tabId, `Tab ${tabId} left ${shared.host}, so sharing stopped.`);
  else if (shared && change.title) shared.title = change.title;
  if (change.status === "complete" || change.title) notify();
});
browser.tabs.onCreated.addListener(() => notify());
