// The foxbridge sidebar: the on switch, the kill switch, the shared tabs
// and the activity log. Page text is set with textContent only, never as
// HTML.
const $ = (id) => document.getElementById(id);
const send = (message) => browser.runtime.sendMessage(message);
let last = null;

function el(tag, { dataset = {}, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  Object.assign(node.dataset, dataset);
  node.append(...children);
  return node;
}

function statusOf(s) {
  if (s.agent) return ["agent", "Agent connected"];
  if (s.on && s.ready) return ["on", "On, waiting for an agent"];
  if (s.on) return ["on", "Starting"];
  return ["off", "Off"];
}

function render(s) {
  last = s;
  const [cls, text] = statusOf(s);
  $("status").className = cls;
  $("status").textContent = text;
  $("power").textContent = s.on ? "Turn off" : "Turn on";
  $("power").className = s.on ? "" : "primary";
  $("error").hidden = !s.error;
  $("error").textContent = s.error;

  $("tabs").replaceChildren(...(s.tabs.length ? s.tabs.map((t) => el("li", {},
    el("label", {},
      el("input", { type: "checkbox", className: "share", checked: t.shared, dataset: { tab: String(t.tabId) } }),
      el("span", { textContent: t.title || t.host }),
      el("small", { textContent: t.host })),
  )) : [el("li", { className: "empty", textContent: "No web pages are open." })]));

  $("log").replaceChildren(...s.log.slice(0, 30).map((entry) => el("li", {},
    el("time", { textContent: new Date(entry.at).toLocaleTimeString() }), entry.text)));
}

const refresh = async () => render(await send({ op: "state" }));

$("power").addEventListener("click", async () => render(await send({ op: last?.on ? "off" : "on" })));
$("stop").addEventListener("click", async () => render(await send({ op: "off" })));
$("tabs").addEventListener("change", async (event) => {
  const box = event.target.closest("input.share");
  if (box) render(await send({ op: "share", tabId: Number(box.dataset.tab), on: box.checked }));
});
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "changed") void refresh();
});
void refresh();
