// The secret that `install` writes, and the proof that the host knows it.
// The MCP server sends a random challenge; the host answers with an
// HMAC-SHA256 of it. A program that took the socket path first cannot
// answer, so the MCP server refuses it (H11).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { FoxbridgeError } from "./errors.js";

const SECRET_RE = /^[0-9a-f]{64}$/;
export const isSecret = (text: string) => SECRET_RE.test(text);
export const newSecret = () => randomBytes(32).toString("hex");
export const newChallenge = () => randomBytes(32).toString("hex");

/** Reads the secret. Throws `no-secret` when it is missing or not 64 hex digits. */
export async function readSecret(path: string): Promise<Buffer> {
  const text = (await readFile(path, "utf8").catch(() => "")).trim();
  if (!isSecret(text)) throw new FoxbridgeError("no-secret", `There is no foxbridge secret at ${path}. Run "foxbridge install".`);
  return Buffer.from(text, "hex");
}

/** The host's answer to a challenge. */
export const hostProof = (secret: Buffer, challenge: string) => createHmac("sha256", secret).update(`foxbridge host proof v1:${challenge}`).digest("hex");

/** True when `proof` is the right answer to `challenge`. */
export function checkProof(secret: Buffer, challenge: string, proof: unknown): boolean {
  if (typeof proof !== "string" || !SECRET_RE.test(proof)) return false;
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(hostProof(secret, challenge), "hex"));
}
