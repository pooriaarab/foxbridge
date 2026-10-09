// The public API of foxbridge.
export { FoxbridgeError, type FoxbridgeErrorCode } from "./errors.js";
export { FrameReader, LIMITS, encodeFrame } from "./frame.js";
export { EXTENSION_ID, HOST_NAME, hostManifest, install, manifestDir, status, uninstall, type HostManifest, type InstallOptions } from "./manifest.js";
