import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Where the host listens and the MCP server connects. FOXBRIDGE_SOCKET
 * wins. Else a socket in ~/.foxbridge (mode 0700), or a named pipe on
 * Windows. The home folder is the same for Firefox and for a terminal.
 */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (env.FOXBRIDGE_SOCKET) return env.FOXBRIDGE_SOCKET;
  if (platform === "win32") return `\\\\.\\pipe\\foxbridge-${env.USERNAME ?? userInfo().username}`;
  return join(home, ".foxbridge", "host.sock");
}

/** Where `install` writes the secret. FOXBRIDGE_SECRET_FILE wins. */
export function defaultSecretPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.FOXBRIDGE_SECRET_FILE || join(home, ".foxbridge", "secret");
}
