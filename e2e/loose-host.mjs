// A test host with no per-tab order (C11 in docs/failure-modes.md). It
// passes every frame through at once, as a buggy or hostile host might, so
// the E2E test can check that the extension keeps its own rules.
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { FrameReader, LIMITS, encodeFrame } from "../dist/index.js";

const path = process.env.FOXBRIDGE_SOCKET;
const toFirefox = (message) => process.stdout.write(encodeFrame(message, LIMITS.toExtension));
let agent;
rmSync(path, { force: true });
const server = createServer((socket) => {
  agent = socket;
  const reader = new FrameReader(LIMITS.socket);
  socket.on("data", (chunk) => reader.push(chunk).forEach(toFirefox));
  socket.on("error", () => undefined);
});
const fromFirefox = new FrameReader(LIMITS.fromExtension);
process.stdin.on("data", (chunk) => fromFirefox.push(chunk).forEach((m) => agent?.write(encodeFrame(m, LIMITS.socket))));
process.stdin.on("end", () => {
  server.close();
  rmSync(path, { force: true });
  process.exit(0);
});
server.listen(path, () => toFirefox({ type: "ready" }));
