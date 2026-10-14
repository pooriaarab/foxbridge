# foxbridge

[![npm version](https://img.shields.io/npm/v/foxbridge)](https://www.npmjs.com/package/foxbridge)
[![downloads/month](https://img.shields.io/npm/dm/foxbridge)](https://www.npmjs.com/package/foxbridge)
[![license](https://img.shields.io/npm/l/foxbridge)](https://www.npmjs.com/package/foxbridge)

[Package](https://www.npmjs.com/package/foxbridge) · [Setup](#connect-your-first-tab) · [MCP tools](#mcp-tools) · [API](#library)

foxbridge is an open-source Firefox bridge for developers who connect outside agents to tabs they explicitly share.
Its Model Context Protocol (MCP) server exposes page reading and browser actions.
A Firefox sidebar asks for approval before changes.

## Install

```sh
npm install -g foxbridge
```

Requires Node.js 24 or later and Firefox 153 or later. The npm package has two direct runtime dependencies and includes TypeScript declarations.
The Firefox extension bundles foxpaw, foxloop browser tools, and foxgate separately.

## Connect your first tab

Install the native messaging host for your user:

```sh
foxbridge install
foxbridge status
```

Success prints `OK:` followed by the manifest path.
Install globally first; an npx cache can disappear and break the launcher.

Build the companion extension from a source checkout:

```sh
gh repo clone pooriaarab/foxbridge
cd foxbridge
pnpm install
pnpm build:ext
```

Open Firefox's `about:debugging`, select **This Firefox**, and load `dist-ext/manifest.json` as a temporary add-on.
Register the installed MCP server with your client. For Claude Code:

```sh
claude mcp add foxbridge -- foxbridge mcp
```

Open the foxbridge sidebar, turn on the bridge, and share one test tab.
Ask your client to call `list_tabs`. Success returns that tab's ID, site, and title.
Shared page text is visible to the client. Use test data for the first connection.
No environment variables or `.env` loader are required for default setup.

The MCP tools are the main way to use foxbridge. The library gives the same
calls to your own Node code. This runs in Node 24 or later when the bridge is
on:

```js
import { connectBridge } from "foxbridge";

const bridge = await connectBridge();
const tabs = await bridge.call("list_tabs", {});
console.log(tabs.summary); // for example: 1 shared tab: tab 12 on github.com.
bridge.close();
```

When the bridge is off, `connectBridge` throws a `FoxbridgeError` with the
code `bridge-off` and a message that says how to turn it on.

## How it works

```text
Agent -> MCP stdio server -> local socket -> native messaging host
                                              |
                                      Firefox extension
                                              |
                              shared tab + foxgate approval
                                              |
                                   foxloop tools -> foxpaw
```

Sharing permits reads. Changes need sidebar approval; one `run_task` approval covers the whole form run.
The extension pins the approved control and refuses stale targets.
Turn off or **Stop now** closes the bridge and clears sharing.

## Why it exists

Terminal agents need an explicit path into a user's existing Firefox session.
Playwright MCP and Chrome DevTools MCP provide other browser-control paths.
foxbridge combines tab sharing, native messaging, and sidebar approvals for Firefox.

## Compare

Scope checked on 2026-10-14 against the linked upstream projects.

| Scope | foxbridge | [Playwright MCP](https://github.com/microsoft/playwright-mcp) | [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) |
| --- | --- | --- | --- |
| Browser path | Firefox extension and native host | Playwright; Chrome extension path available | Chrome DevTools |
| Agent transport | MCP | MCP | MCP |
| Local setup | Global package, native manifest, companion extension | Package and browser configuration | Package and Chrome configuration |

## Coverage

Source inventory: six MCP tools, five CLI commands, and three bundled fox integrations.
No live client compatibility campaign was performed for this rewrite.

| Integration | Status | Role |
| --- | --- | --- |
| Firefox native messaging | Implemented | Host and extension transport |
| MCP stdio clients | Implemented | Tool interface; client registration required |
| Claude Code | Setup example | Starts `foxbridge mcp`; no special client adapter |
| foxpaw | Bundled implementation | Page snapshots and actions |
| foxloop | Bundled implementation | Browser tool schemas and target preparation |
| foxgate | Bundled implementation | Grants and approvals |
| Windows native host | Unverified on Windows | Registry, launcher, permissions, and named-pipe code |

## Common use cases

1. Claude Code users read a shared Firefox test tab through MCP.
2. QA engineers inspect controls, approve a form action, and take another snapshot.
3. Node.js developers script shared-tab queries with `connectBridge`.
4. Accessibility tool authors use Firefox control roles and labels to present actions.
5. Agent framework authors add a human approval step through foxgate and the sidebar.

## Features

- Per-tab sharing limits which pages the bridge exposes.
- Sidebar approvals gate changes and new tabs.
- Native-host proof checks the local installation secret before calls.
- Page text returns in a separate untrusted content block.
- Structured refusal codes explain denied, stale, or timed-out calls.

## Runtime surfaces

### MCP tools

| Tool | Arguments | What it does |
|---|---|---|
| `list_tabs` | none | The shared tabs: tab id, site and title. |
| `snapshot` | `tabId` | The controls and the text of a shared tab. No approval. |
| `act` | `tabId`, `controlId`, `op`, `value?` | Types, selects, checks, unchecks, sets a date or scrolls one control from the last snapshot. Needs an approval. |
| `click` | `tabId`, `controlId` | Clicks one control from the last snapshot. Needs an approval. |
| `run_task` | `tabId`, `goal` | Runs foxpaw's `runTask`, for example `email: sam@example.com, accept the terms`. One approval covers the run. |
| `open_url` | `url` | Opens an `http:` or `https:` address in a new tab and shares it. Needs an approval. |

A refusal is an MCP result with `isError: true` and a code:
`bridge-off`, `busy`, `host-gone`, `timeout`, `too-large`, `not-shared`,
`bad-args`, `denied`, `approval-denied`, `approval-timeout`,
`approval-cancelled`, `tab-busy`, `stale`, `bad-host`, `no-secret` or `unknown-tool`.

### CLI

| Command | What it does |
|---|---|
| `foxbridge install [--extension-id <id>]` | Writes the launcher `~/.foxbridge/foxbridge-host`, the secret `~/.foxbridge/secret` and the host manifest. On Windows, it also writes `HKCU\Software\Mozilla\NativeMessagingHosts\foxbridge`. |
| `foxbridge uninstall` | Removes them. |
| `foxbridge status` | Checks the manifest, the extension id and the launcher. Exits 1 with the problems. |
| `foxbridge mcp` | Runs the MCP server on stdio. |
| `foxbridge host` | Runs the native messaging host. Firefox starts it. |

The manifest goes to
`~/Library/Application Support/Mozilla/NativeMessagingHosts/foxbridge.json`
on macOS and `~/.mozilla/native-messaging-hosts/foxbridge.json` on Linux.
Its `allowed_extensions` holds only `foxbridge@pooriaarab`.
`FOXBRIDGE_SOCKET` changes the socket path for both the host and the MCP
server. The host refuses a socket folder that is a symlink, belongs to
another user, or is open to other users (`unsafe-folder`), so
`FOXBRIDGE_SOCKET=/tmp/x.sock` does not work. Use a folder of your own with
mode 0700.

### Library

| Export | What it does |
|---|---|
| `connectBridge({ socketPath?, timeoutMs? })` | Connects to the host. Returns `{ call(tool, args), close(), closed }`. |
| `createMcpServer({ connect?, nonce?, version? })` | The MCP server, for your own transport. |
| `runHost({ input, output, socketPath, log? })` | The native messaging host on any two streams. |
| `install`, `uninstall`, `status`, `manifestDir`, `hostManifest` | The host manifest. |
| `encodeFrame`, `FrameReader`, `LIMITS` | The frames and their limits. |
| `formatReply`, `wrapUntrusted`, `UNTRUSTED_NOTE` | How page text goes back to the agent. |
| `FoxbridgeError` | Has a `code`. |

### The extension

The foxbridge extension is the part that runs in Firefox. Its sidebar has an
on switch, an agent indicator, the tabs to share, the approval cards, an
activity log, the approval time, and **Stop now**. Stop now closes the native
port, denies what waits, and stops all sharing. Turn off does the same.

```bash
pnpm install
pnpm e2e    # Firefox, the real host manifest, a real MCP client
```

`pnpm e2e` temporarily installs the per-user host manifest and restores it after the run.
Do not run two Firefox E2E sessions together.

### Message protocol

Every link uses Firefox's native messaging frame: a 32-bit length in native
byte order, then that many bytes of UTF-8 JSON.

| Link | Limit | Messages |
|---|---|---|
| MCP server to host (socket) | 8 MB | `call {id, tool, args}`, `cancel {id}` |
| Host to MCP server | 8 MB | `hello`, `refused {code}`, `reply {id, ok, result \| error}` |
| Host to extension (stdout) | 1 MB, set by Firefox | `ready`, `agent {connected}`, `call`, `cancel`, `host-error` |
| Extension to host (stdin) | 8 MB, set by foxbridge | `reply {id, ok, result \| error}` |

- The MCP server first sends a random challenge. The host answers in
  `hello` with an HMAC-SHA256 of it, keyed with the secret that `install`
  wrote to `~/.foxbridge/secret` (mode 0600). The MCP server refuses a host
  that cannot prove the secret (`bad-host`), so a program that took the
  socket path first sees no call and cannot forge an answer. On Windows,
  libuv makes the first pipe instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`,
  so the real host fails with `socket-busy` instead of sharing a name that
  another program holds.
- The MCP server gives each call a random id. The host passes only answers
  for ids that wait, one agent at a time.
- The host sends one call for a tab at a time, in order. A `snapshot` sent
  while an `act` waits for its approval answers after the approval. The
  extension keeps the same order itself, and refuses a `snapshot` with
  `tab-busy` while an approval for that tab waits.
- A call over 1 MB fails with `too-large` before Firefox sees it.
- A call waits at most 180 s (`FOXBRIDGE_TIMEOUT_MS`). Then the MCP server
  sends `cancel`, and the extension drops the approval.
- An approval waits 120 s by default. You can set 2 to 150 s in the sidebar.
- When the host stops, every waiting call fails at once with `host-gone`.

## Delivery/behavior limits

- foxbridge marks page text as untrusted data. It cannot stop an agent that
  obeys the page anyway. Every change still needs a shared tab and your
  approval.
- A shared tab is readable with no approval. Share only the tabs that the
  agent may read.
- The approval card names a control by the label that the page gives it. A
  hostile page can give a button a false label. Check the site before you
  approve.
- Any program that runs as your user can read the secret and connect to the
  socket while the bridge is on. The secret keeps out other users, not your
  own programs. The sidebar shows **Agent
  connected**, and only one agent can connect at a time.
- One approval for `run_task` covers the whole foxpaw run, and the run can
  send a form.
- Sharing stops when a tab moves to another site. A redirect from
  `example.com` to `www.example.com` also stops it.
- The state lives in memory. After a Firefox restart, the bridge is off and no
  tab is shared. Turn off also stops all sharing.
- foxpaw sends synthetic in-page events. Some sites ignore them.
- Windows host support exists in code but lacks a real Windows verification here.
- Calls wait 180 seconds by default; approvals wait 120 seconds by default.
- Set `FOXBRIDGE_TIMEOUT_MS` for CLI call timeouts and `FOXBRIDGE_SOCKET` for a custom socket path.
- Export environment variables before starting the server. foxbridge does not load `.env` files.

## Integration guides

- [Firefox and Claude Code setup](#connect-your-first-tab): install the host, build the extension, and share a test tab.
- [Node.js bridge API](#library): connect, call tools, and close the connection.
- [Native transport protocol](#message-protocol): inspect frames, limits, and host authentication.

## Status

Version 0.1.4 is a 0.x release. Interfaces can change.
Use the issue channel listed on the [npm package](https://www.npmjs.com/package/foxbridge) for support.
Public customer case studies are not published here.

## FAQ

### What does foxbridge connect?

foxbridge connects MCP clients to explicitly shared Firefox tabs.
Its native host links the local server and companion extension.

### Which integrations are verified?

foxbridge implements Firefox native messaging, MCP tools, and three bundled fox libraries.
This rewrite verifies the local gate; Windows and live client compatibility remain separate checks.

### Does foxbridge provide a managed browser?

foxbridge uses Firefox on your machine.
You install its host and extension and choose which tabs to share.

### How is foxbridge different from Playwright MCP?

foxbridge uses a Firefox native messaging host and approval sidebar.
[Playwright MCP](https://github.com/microsoft/playwright-mcp) exposes browser automation through Playwright and offers a Chrome extension path.

### How is foxbridge different from Chrome DevTools MCP?

foxbridge connects to shared Firefox tabs.
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) exposes Chrome DevTools to agents.

### Does every read need approval?

foxbridge permits snapshots of shared tabs without another approval.
Share only pages the agent may read.

### Can a form submit after one approval?

foxbridge's `run_task` approval covers the whole foxpaw run.
That run can fill and submit a form.

### Does untrusted wrapping stop prompt injection?

foxbridge marks page content as untrusted text for the client.
An agent can still follow malicious page instructions; wrapping is not a security guarantee.

## License

MIT.
