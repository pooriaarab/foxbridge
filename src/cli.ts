#!/usr/bin/env node
// The foxbridge command. Logs go to stderr: in `mcp` and `host` mode,
// stdout carries the protocol.
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runHost } from "./host.js";
import { install, status, uninstall } from "./manifest.js";
import { connectBridge } from "./client.js";
import { createMcpServer } from "./mcp.js";
import { DEFAULT_TIMEOUT_MS } from "./protocol.js";
import { defaultSocketPath } from "./socket.js";

const HELP = `foxbridge: let outside agents use the Firefox tabs you share.

Usage: foxbridge <command>

  install [--extension-id <id>]  Write the native messaging host manifest for Firefox.
  uninstall                      Remove the manifest and the launcher.
  status                         Check what Firefox finds.
  mcp                            Run the MCP server on stdio. Agents start this.
  host                           Run the native messaging host. Firefox starts this.

Register it with Claude Code: claude mcp add foxbridge -- foxbridge mcp
Environment: FOXBRIDGE_SOCKET (the socket path), FOXBRIDGE_TIMEOUT_MS (default ${DEFAULT_TIMEOUT_MS}).`;

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const [command, ...rest] = process.argv.slice(2);

async function main(): Promise<number> {
  switch (command) {
    case "install": {
      const at = rest.indexOf("--extension-id");
      const extensionId = at >= 0 ? rest[at + 1] : undefined;
      const result = await install(extensionId ? { extensionId } : {});
      console.log(`Wrote ${result.manifestPath}\nWrote ${result.launcherPath}`);
      for (const warning of result.warnings) console.error(`Warning: ${warning}`);
      return 0;
    }
    case "uninstall": {
      const { removed } = await uninstall();
      console.log(removed.length ? removed.map((file) => `Removed ${file}`).join("\n") : "Nothing to remove.");
      return 0;
    }
    case "status": {
      const result = await status();
      console.log(result.ok ? `OK: ${result.manifestPath}` : result.problems.join("\n"));
      return result.ok ? 0 : 1;
    }
    case "mcp": {
      const timeoutMs = Number(process.env.FOXBRIDGE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
      const server = createMcpServer({ version, connect: () => connectBridge({ socketPath: defaultSocketPath(), timeoutMs }) });
      await server.connect(new StdioServerTransport());
      console.error(`foxbridge ${version}: MCP server on stdio. Socket: ${defaultSocketPath()}`);
      return -1;
    }
    case "host": {
      const host = await runHost({ input: process.stdin, output: process.stdout, socketPath: defaultSocketPath() });
      await host.closed;
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    console.error(`foxbridge: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
