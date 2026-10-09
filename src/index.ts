// The public API of foxbridge.
export { FoxbridgeError, type FoxbridgeErrorCode } from "./errors.js";
export { FrameReader, LIMITS, encodeFrame } from "./frame.js";
export { EXTENSION_ID, HOST_NAME, hostManifest, install, manifestDir, status, uninstall, type HostManifest, type InstallOptions } from "./manifest.js";
export { DEFAULT_APPROVAL_SECONDS, DEFAULT_TIMEOUT_MS, MAX_APPROVAL_SECONDS, MESSAGES, MIN_APPROVAL_SECONDS, TOOL_NAMES } from "./protocol.js";
export type { AgentMessage, CallError, ExtensionToHost, HostToAgent, HostToExtension, ToolName, ToolReply } from "./protocol.js";
export { defaultSecretPath, defaultSocketPath } from "./socket.js";
export { checkProof, hostProof, readSecret } from "./secret.js";
export { runHost, type HostOptions, type RunningHost } from "./host.js";
export { connectBridge, type Bridge, type BridgeOptions } from "./client.js";
export { UNTRUSTED_NOTE, createMcpServer, formatReply, wrapUntrusted, type McpOptions } from "./mcp.js";
