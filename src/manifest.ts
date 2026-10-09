// The native messaging host manifest, and the launcher script it points
// to. Firefox runs the launcher, and the launcher runs `foxbridge host`.
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FoxbridgeError } from "./errors.js";

/** The native application name. The extension calls `connectNative("foxbridge")`. */
export const HOST_NAME = "foxbridge";
/** The gecko id of the foxbridge extension. */
export const EXTENSION_ID = "foxbridge@pooriaarab";
const REG_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_extensions: string[];
}

export interface InstallOptions {
  /** Default: the user's home folder. */
  home?: string;
  /** Default: process.platform. */
  platform?: NodeJS.Platform;
  /** Default: the foxbridge extension id. Change it only to test a refusal. */
  extensionId?: string;
  /** The Node binary the launcher runs. Default: this Node. */
  nodePath?: string;
  /** The foxbridge CLI file. Default: dist/cli.js of this package. */
  cliPath?: string;
  /** Runs `reg` on Windows. Default: the real `reg.exe`. */
  reg?: (args: string[]) => Promise<void>;
}

/** The folder where Firefox looks for the manifest. On Windows, the registry points to it. */
export function manifestDir(platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts");
  if (platform === "linux") return join(home, ".mozilla", "native-messaging-hosts");
  if (platform === "win32") return join(home, ".foxbridge");
  throw new FoxbridgeError("unsupported-platform", `foxbridge does not know where Firefox reads host manifests on ${platform}.`);
}

/** The manifest Firefox reads. */
export function hostManifest(launcherPath: string, extensionId = EXTENSION_ID): HostManifest {
  return {
    name: HOST_NAME,
    description: "foxbridge: lets outside agents use the shared tabs you approve.",
    path: launcherPath,
    type: "stdio",
    allowed_extensions: [extensionId],
  };
}

const paths = (o: InstallOptions) => {
  const platform = o.platform ?? process.platform;
  const home = o.home ?? homedir();
  const dir = manifestDir(platform, home);
  const launcherDir = join(home, ".foxbridge");
  const launcherPath = join(launcherDir, platform === "win32" ? "foxbridge-host.cmd" : "foxbridge-host");
  return { platform, dir, manifestPath: join(dir, `${HOST_NAME}.json`), launcherDir, launcherPath };
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const realReg = (args: string[]) =>
  new Promise<void>((resolve, reject) => execFile("reg", args, (error) => (error ? reject(error) : resolve())));

/** Writes the launcher and the manifest. On Windows, also the registry key. */
export async function install(o: InstallOptions = {}): Promise<{ manifestPath: string; launcherPath: string; warnings: string[] }> {
  const { platform, dir, manifestPath, launcherDir, launcherPath } = paths(o);
  const nodePath = o.nodePath ?? process.execPath;
  const cliPath = o.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url));
  const warnings: string[] = [];
  if (/[\\/]_npx[\\/]/.test(cliPath)) {
    warnings.push(`The CLI runs from an npx cache (${cliPath}). npm can delete that folder, and then Firefox cannot start the host. Run "npm i -g foxbridge", then "foxbridge install".`);
  }
  await mkdir(launcherDir, { recursive: true, mode: 0o700 });
  await mkdir(dir, { recursive: true });
  const launcher = platform === "win32"
    ? `@echo off\r\n"${nodePath}" "${cliPath}" host %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(cliPath)} host "$@"\n`;
  await writeFile(launcherPath, launcher, { mode: 0o755 });
  await chmod(launcherPath, 0o755);
  await writeFile(manifestPath, `${JSON.stringify(hostManifest(launcherPath, o.extensionId), null, 2)}\n`);
  if (platform === "win32") await (o.reg ?? realReg)(["add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
  return { manifestPath, launcherPath, warnings };
}

/** Removes the manifest and the launcher. On Windows, also the registry key. */
export async function uninstall(o: InstallOptions = {}): Promise<{ removed: string[] }> {
  const { platform, manifestPath, launcherPath } = paths(o);
  const removed: string[] = [];
  for (const file of [manifestPath, launcherPath]) {
    if (await stat(file).catch(() => null)) {
      await rm(file);
      removed.push(file);
    }
  }
  if (platform === "win32") await (o.reg ?? realReg)(["delete", REG_KEY, "/f"]).catch(() => undefined);
  return { removed };
}

/** Checks what Firefox will find. `problems` says what to fix. */
export async function status(o: InstallOptions = {}): Promise<{ ok: boolean; manifestPath: string; problems: string[] }> {
  const { manifestPath } = paths(o);
  const problems: string[] = [];
  const text = await readFile(manifestPath, "utf8").catch(() => null);
  if (text === null) {
    problems.push(`There is no host manifest at ${manifestPath}. Run "foxbridge install".`);
    return { ok: false, manifestPath, problems };
  }
  let manifest: Partial<HostManifest> = {};
  try {
    manifest = JSON.parse(text) as Partial<HostManifest>;
  } catch {
    problems.push(`${manifestPath} is not JSON. Run "foxbridge install".`);
  }
  if (manifest.name !== HOST_NAME) problems.push(`The manifest name is "${String(manifest.name)}", not "${HOST_NAME}".`);
  const ids = manifest.allowed_extensions ?? [];
  if (ids.length !== 1 || ids[0] !== EXTENSION_ID) problems.push(`allowed_extensions is ${JSON.stringify(ids)}. Firefox lets only those extensions connect, and foxbridge is "${EXTENSION_ID}".`);
  const launcher = typeof manifest.path === "string" ? await stat(manifest.path).catch(() => null) : null;
  if (!launcher) problems.push(`The manifest points to ${String(manifest.path)}, and that file does not exist. Run "foxbridge install".`);
  return { ok: problems.length === 0, manifestPath, problems };
}
