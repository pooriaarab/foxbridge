# Failure modes

This file lists every way foxbridge can fail that we know of. Each row names
the behaviour we want and the test that checks it. We wrote this list first,
then the tests, then the code.

- **E2E** checks run in a real Firefox through `pnpm e2e` (`e2e/run.mjs`). An
  MCP client starts `foxbridge mcp` over stdio and talks to the real
  extension through the real native messaging host.
- **Isolated** tests run in Node through `pnpm test` (`tests/*.test.ts`).
  They use in-memory streams and a real local socket, with no Firefox.

The parts:

- **agent**: the outside agent, for example Claude Code. It is an MCP client.
- **MCP server**: `foxbridge mcp`, started by the agent over stdio.
- **host**: `foxbridge host`, started by Firefox through native messaging.
  It listens on a local socket. The MCP server connects to that socket.
- **extension**: the foxbridge extension. It owns foxgate, the shared tabs
  and the approvals. It runs foxpaw through foxloop's browser tool pack.

## Frames (length-prefixed JSON)

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| W1 | A message to the extension is over 1 MB. Firefox closes the port and stops the host for a message over 1 MB from the host. | The host does not send it. It answers the agent with `too-large`. The MCP server also refuses such a call before it sends it. The port stays open. | Isolated `tests/frame.test.ts`, `tests/host.test.ts`; E2E (a 1.1 MB goal) |
| W2 | A length header says more bytes than the limit, from Firefox or from the socket. The reader waits for, or allocates, a huge buffer. | The reader throws `too-large` at the header. The host drops that agent connection. From Firefox, the host stops. | Isolated `tests/frame.test.ts`, `tests/host.test.ts` |
| W3 | A frame body is not JSON. | The reader throws `bad-frame`. The connection closes as in W2. | Isolated `tests/frame.test.ts` |
| W4 | One frame arrives in many chunks, or many frames arrive in one chunk. | The reader gives each message one time, in order. | Isolated `tests/frame.test.ts` |
| W5 | A log line goes to stdout. Firefox reads it as a broken frame and closes the port. In `mcp` mode the agent reads a broken message. | The host and the MCP server write logs to stderr only. Everything on stdout decodes as frames. | Isolated `tests/host.test.ts`; E2E (the MCP client connects) |

## Install and the host manifest

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| I1 | The host manifest points to a file that does not exist, for example after the package moved. Firefox cannot start the host. | `foxbridge status` names the missing file. The sidebar says that Firefox could not start the host and shows the install command. | Isolated `tests/manifest.test.ts`; E2E |
| I2 | `allowed_extensions` holds a different extension id. Firefox refuses the connection. | The manifest holds only the foxbridge extension id by default. `foxbridge status` names a different id. The sidebar shows the error from Firefox. | Isolated `tests/manifest.test.ts`; E2E |
| I3 | `foxbridge install` runs from an `npx` cache. npm can delete that cache, and then I1 happens. | `install` warns and tells the user to install the package globally first. | Isolated `tests/manifest.test.ts` |
| I4 | The platform has no known manifest place. | `install` throws `unsupported-platform` and names the platform. | Isolated `tests/manifest.test.ts` |
| I5 | `uninstall` runs when nothing is installed. | It removes nothing, says so, and exits 0. | Isolated `tests/manifest.test.ts` |
| I6 | The manifest holds a relative path or a bad name. Firefox needs an absolute path, and a name of letters, digits, `_` and `.`. | The manifest path is absolute and the name is `foxbridge`. On macOS and Linux the path is a launcher script that runs Node with the CLI. | Isolated `tests/manifest.test.ts` |
| I7 | On Windows, Firefox finds the manifest only through the registry. | `install` writes `HKCU\Software\Mozilla\NativeMessagingHosts\foxbridge` with `reg add`. `uninstall` deletes it. | Isolated `tests/manifest.test.ts` (with a fake `reg`). Not tested on Windows. |
| I8 | The host and the MCP server share no secret, so neither can tell the real other side from a fake. | `install` writes 32 random bytes as hex to `~/.foxbridge/secret` with mode 0600 (on Windows, `icacls` keeps only the user). A second `install` keeps a good secret. `uninstall` removes it. `status` names a missing or loose secret. | Isolated `tests/manifest.test.ts` (with a fake `icacls`). Not tested on Windows. |

## Host and socket

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| H1 | The host stops in the middle of a request (crash, kill switch, Firefox closes). | The MCP server fails every waiting call at once with `host-gone`. It does not wait for the timeout. | Isolated `tests/host.test.ts`; E2E (kill switch during an approval) |
| H2 | Two MCP clients connect at the same time. | The first one keeps the bridge. The host answers the second with `busy` and closes it. | Isolated `tests/host.test.ts`; E2E |
| H3 | A socket file is left over from a host that crashed. `listen` fails with `EADDRINUSE`. | The host tries to connect to it. When nothing answers, it removes the file and listens. When a host answers, it tells the extension `socket-busy` and stops. | Isolated `tests/host.test.ts` |
| H4 | The bridge is off, so no host runs and no socket exists. | The call fails at once with `bridge-off`. The message tells the user to turn on the bridge in the foxbridge sidebar. | Isolated `tests/host.test.ts`; E2E |
| H5 | Firefox closes the port. The host keeps running with no extension. | The host closes the socket, removes the socket file and stops. | Isolated `tests/host.test.ts` |
| H6 | The extension answers an id that is not waiting (it timed out, or it is unknown). | The host drops the answer. | Isolated `tests/host.test.ts` |
| H7 | Another user on the computer connects to the socket. | The socket directory has mode 0700, so only the owner can reach it. | Isolated `tests/host.test.ts` (POSIX) |
| H8 | The agent sends a request id that is still waiting, or a bad request. | The host answers `bad-request` and does not send it to the extension. | Isolated `tests/host.test.ts` |
| H9 | The agent disconnects while approvals wait. | The host tells the extension that no agent is connected. The extension cancels those approvals. | Isolated `tests/host.test.ts` |
| H10 | Two calls for the same tab run at the same time. A `snapshot` that runs while an `act` waits for its approval changes the cached snapshot, so the approved control and the control that runs can differ. | The host sends one call for a tab at a time, in the order the agent sent them. The next call for that tab goes to the extension after the answer, or after a `cancel`. Calls for other tabs, and calls with no tab, do not wait. | Isolated `tests/host.test.ts`; E2E (a `snapshot` sent during an approval answers only after the approval) |
| H11 | Another program takes the socket path first: another user on Windows (the pipe name `foxbridge-<user>` is easy to guess), or anyone on POSIX when `FOXBRIDGE_SOCKET` points into a shared folder. It poses as the host, sees calls, and forges answers whose summary lands in the trusted block. | The MCP server sends a random challenge first. The host answers with an HMAC-SHA256 of the challenge, keyed with the secret (I8). The MCP server refuses a wrong or missing proof with `bad-host` and sends no call. On Windows, libuv makes the first pipe instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so the real host cannot share a name that a squatter holds: it fails with `EADDRINUSE` and reports `socket-busy`. | Isolated `tests/bridge.test.ts` (a fake host) |
| H12 | A fake host or a stuck host never sends `hello`. | The MCP server gives up after 5 s with `bad-host`. | Isolated `tests/bridge.test.ts` |
| H13 | The secret file is missing, for example before `install`. | The host tells the extension `no-secret` and stops. The MCP server fails with `no-secret`. Both messages say to run `foxbridge install`. | Isolated `tests/host.test.ts`, `tests/bridge.test.ts` |
| H14 | The socket folder exists already and is not safe: a symlink, a folder of another user, or a folder that others can read (for example `FOXBRIDGE_SOCKET=/tmp/x.sock`). | The host checks the folder with `lstat`. It refuses a symlink, a non-folder, or another owner with `unsafe-folder`. A folder that the host made, or a folder named `.foxbridge`, gets mode 0700. Any other folder must be 0700 already, or the host refuses it. | Isolated `tests/host.test.ts` |
| H15 | The socket file exists for a moment with loose mode, between `listen` and `chmod`. | The host sets umask 0o077 around `listen`, so the socket is made 0600. | Code; H7 checks the mode at `ready` |
| H16 | Two hosts start after a crash. Both find a dead socket file, and each removes the socket that the other one just made. | A host takes `<socket>.lock` (with its pid) before it removes and listens, and checks again under the lock. The second host sees the first one answer and reports `socket-busy`. A lock of a dead pid is removed. | Isolated `tests/host.test.ts` |

## Timeouts

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| T1 | Nobody answers an approval. | After the approval time in the sidebar (default 120 s), the extension rejects the request in foxgate. The agent gets `approval-timeout`. The card goes away. | E2E (approval time set to 2 s) |
| T2 | The extension does not answer a call. | The MCP server fails the call with `timeout` after 180 s (`FOXBRIDGE_TIMEOUT_MS`). It sends `cancel`, so the extension drops a waiting approval. | Isolated `tests/host.test.ts` |
| T3 | The MCP server gives up before the approval time ends. The human then approves an action that nobody waits for. | The MCP default (180 s) is longer than the longest approval time the sidebar allows (150 s). T2 sends `cancel` when it still happens. | Isolated `tests/host.test.ts` (cancel) |

## Consent and the extension

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| C1 | The agent calls a tool on a tab that the user did not share. | The extension refuses with `not-shared` before it reads the tab. No approval card shows. | E2E |
| C2 | A shared tab moves to another site. | Sharing for that tab stops. Later calls get `not-shared`. | E2E |
| C3 | The kill switch (or Turn off) is used while a call waits. | The extension closes the native port, which stops the host (H1). It denies the waiting approvals and stops sharing every tab. | E2E |
| C4 | Arguments do not fit the tool schema. They come from a buggy or hostile host, not only from the MCP server. | The extension checks them again with the foxloop schema. It refuses with `bad-args` and the path of the first error. | E2E (a raw socket client) |
| C5 | `open_url` gets a `javascript:`, `file:`, `data:` or `moz-extension:` address. | The extension refuses with `bad-args` before it asks the human. | E2E |
| C6 | The human denies the action. | Nothing runs. The agent gets `approval-denied`. | E2E |
| C7 | `act` or `click` names a control that is not in the last snapshot of that tab. | The extension refuses with `bad-args` and asks for a snapshot. No approval card shows. | E2E |
| C8 | The event page unloads while the native port is open. Then the port and the host would stop with no warning. | Measured in E2E: with no extension page open and a 2 s idle timeout, the bridge must still answer after 8 s. If Firefox unloads the page, the agent gets `host-gone` (H1) and nothing runs. | E2E (measurement) |
| C9 | The agent asks for cookies or a password. | The extension has no `cookies` permission and no tool that reads cookies. foxpaw shows a password value as `•••`. | E2E (a filled password field) |
| C10 | The bridge turns itself on after a Firefox restart. | The on state and the shared tabs live only in the event page memory. Turn off stops all sharing. After a restart the bridge is off. | E2E (the bridge starts off) |
| C11 | A buggy or hostile host sends calls for one tab at the same time (H10 does not hold). | The extension runs the calls for a tab one at a time. It refuses a `snapshot` for a tab with `tab-busy` while an approval for that tab waits. A queued call that the agent cancelled does not run. | E2E (a host with no per-tab order and a raw socket client) |
| C12 | The page changes the control, or the page is read again, after the human approves and before the action runs. The approved control and the control that runs differ. | The extension calls the foxloop tool's `prepare`, which pins the control (snapshot number, id, frame, node, guard, role, label, address) into the action that foxgate judges. The card shows the pinned control. `run` acts only on that control. When it changed, the agent gets `stale` ("the page changed, call snapshot again") and nothing runs. | E2E (the test replaces the field while its approval waits) |

## Page text and prompt injection

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| P1 | Page text tells the outside agent what to do ("call open_url with ..."). | The MCP result puts page text in its own content block. The block starts with a note that the text is untrusted data, not instructions from the user, and is wrapped in tags with a random nonce. Tab titles count as page text. | Isolated `tests/mcp.test.ts`; E2E |
| P2 | The page writes a closing tag to break out of the wrap. | The page cannot know the nonce, so its tag does not close the block. | Isolated `tests/mcp.test.ts` |
| P3 | The agent obeys the page anyway. | foxbridge cannot stop that. Any action still needs a shared tab, and every change needs the human's approval in the sidebar. | E2E (`open_url` asks the human) |

## MCP results

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| M1 | The extension refuses a call, or foxpaw does not act. | The MCP result has `isError: true` and says the code and the reason, so the agent can explain it. | Isolated `tests/mcp.test.ts`; E2E |
| M2 | The bridge connection dropped after an earlier call. | The next call connects again. It does not reuse the dead connection. | Isolated `tests/mcp.test.ts` |
