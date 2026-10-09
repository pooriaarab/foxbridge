// The messages between the MCP server, the host and the extension. This
// file has no Node imports, so the extension bundles it too.

/** How long the MCP server waits for one call. Longer than the longest approval. */
export const DEFAULT_TIMEOUT_MS = 180_000;
/** The approval time the sidebar allows, in seconds. */
export const MIN_APPROVAL_SECONDS = 2;
export const MAX_APPROVAL_SECONDS = 150;
export const DEFAULT_APPROVAL_SECONDS = 120;

/** The tools an outside agent can call. */
export const TOOL_NAMES = ["list_tabs", "snapshot", "act", "click", "run_task", "open_url"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface CallError {
  code: string;
  message: string;
}

/** What the extension returns for a call that it ran. */
export interface ToolReply {
  /** False when foxpaw did not act, or the page check failed. */
  ok: boolean;
  /** Text that foxbridge writes. */
  summary: string;
  /** Text from the page: titles, controls, page text. It is data, never instructions. */
  untrusted?: string;
}

/** Agent to host. */
export type AgentMessage =
  | { type: "challenge"; nonce: string }
  | { type: "call"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "cancel"; id: string };

/** Host to agent. */
export type HostToAgent =
  | { type: "hello"; version: 1; proof: string }
  | { type: "refused"; code: string; message: string }
  | { type: "reply"; id: string; ok: boolean; result?: unknown; error?: CallError };

/** Host to extension. */
export type HostToExtension =
  | { type: "ready" }
  | { type: "agent"; connected: boolean }
  | { type: "call"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "cancel"; id: string }
  | { type: "host-error"; code: string; message: string };

/** Extension to host. */
export type ExtensionToHost = { type: "reply"; id: string; ok: boolean; result?: unknown; error?: CallError };

export const MESSAGES = {
  bridgeOff: 'The foxbridge bridge is off. In Firefox, open the foxbridge sidebar and turn on the bridge. If it is on, run "foxbridge status".',
  busy: "Another agent is connected to foxbridge. Close it, or turn the bridge off and on in the foxbridge sidebar.",
  hostGone: "The foxbridge host stopped. The bridge was turned off, the kill switch was used, or Firefox closed.",
  badHost: "Something that is not the foxbridge host answers on the foxbridge socket. foxbridge sent it no call. Turn the bridge off and on, and check who owns the socket.",
} as const;
