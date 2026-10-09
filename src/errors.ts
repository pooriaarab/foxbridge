/**
 * Codes foxbridge sets itself. A call can also fail with a code from the
 * extension, for example `not-shared`, `approval-denied` or `bad-args`.
 */
export type FoxbridgeErrorCode =
  | "too-large"
  | "bad-frame"
  | "bridge-off"
  | "busy"
  | "host-gone"
  | "timeout"
  | "bad-request"
  | "unsupported-platform"
  | (string & {});

export class FoxbridgeError extends Error {
  readonly code: FoxbridgeErrorCode;
  constructor(code: FoxbridgeErrorCode, message: string) {
    super(message);
    this.name = "FoxbridgeError";
    this.code = code;
  }
}
