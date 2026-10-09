// The native messaging host manifest, and the launcher script it points
// to. Firefox runs the launcher, and the launcher runs `foxbridge host`.
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FoxbridgeError } from "./errors.js";
import { isSecret, newSecret } from "./secret.js";

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
  /** Runs `icacls` on Windows. Default: the real `icacls.exe`. */
  icacls?: (args: string[]) => Promise<void>;
  /** The Windows user that keeps access to the secret. Default: the current user. */
  username?: string;
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
  return { platform, dir, manifestPath: join(dir, `${HOST_NAME}.json`), launcherDir, launcherPath, secretPath: join(launcherDir, "secret") };
};

/** npx (`_npx`), pnpm dlx (`dlx/`), yarn dlx (`xfs-…/dlx-…`) and bunx (`bunx-…`) caches. */
const RUNNER_CACHE = /[\\/](_npx|dlx(-[^\\/]*)?)[\\/]|[\\/]bunx-[^\\/]*[\\/]/;

/** The Node binary and the CLI file that a launcher runs (I9). */
function launcherTargets(text: string): string[] {
  const posix = text.match(/^exec ('(?:[^']|'\\'')*') ('(?:[^']|'\\'')*') host/m);
  if (posix) return [posix[1], posix[2]].map((q) => (q ?? "").slice(1, -1).replaceAll(`'\\''`, "'"));
  const windows = text.match(/^"([^"]*)" "([^"]*)" host/m);
  return windows ? [windows[1] ?? "", windows[2] ?? ""] : [];
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const run = (command: string) => (args: string[]) =>
  new Promise<void>((resolve, reject) => execFile(command, args, (error) => (error ? reject(error) : resolve())));
const realReg = run("reg");

/** Writes the launcher and the manifest. On Windows, also the registry key. */
export async function install(o: InstallOptions = {}): Promise<{ manifestPath: string; launcherPath: string; secretPath: string; warnings: string[] }> {
  const { platform, dir, manifestPath, launcherDir, launcherPath, secretPath } = paths(o);
  const nodePath = o.nodePath ?? process.execPath;
  const cliPath = o.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url));
  const warnings: string[] = [];
  if (RUNNER_CACHE.test(cliPath)) {
    warnings.push(`The CLI runs from a package runner cache (${cliPath}), as with npx, pnpm dlx, yarn dlx or bunx. The runner can delete that folder, and then Firefox cannot start the host. Run "npm i -g foxbridge", then "foxbridge install".`);
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
  // I8: the secret that the host proves in hello. A good secret stays, so
  // a running host and a running MCP server keep agreeing.
  if (!isSecret((await readFile(secretPath, "utf8").catch(() => "")).trim())) await writeFile(secretPath, newSecret(), { mode: 0o600 });
  await chmod(secretPath, 0o600);
  if (platform === "win32") await (o.icacls ?? run("icacls"))([secretPath, "/inheritance:r", "/grant:r", `${o.username ?? userInfo().username}:F`]);
  return { manifestPath, launcherPath, secretPath, warnings };
}

/** Removes the manifest and the launcher. On Windows, also the registry key. */
export async function uninstall(o: InstallOptions = {}): Promise<{ removed: string[] }> {
  const { platform, manifestPath, launcherPath, secretPath } = paths(o);
  const removed: string[] = [];
  for (const file of [manifestPath, launcherPath, secretPath]) {
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
  const { platform, manifestPath, secretPath } = paths(o);
  const problems: string[] = [];
  const secret = await stat(secretPath).catch(() => null);
  if (!secret || !isSecret((await readFile(secretPath, "utf8")).trim())) problems.push(`There is no good secret at ${secretPath}. Run "foxbridge install".`);
  else if (platform !== "win32" && (secret.mode & 0o077) !== 0) problems.push(`${secretPath} can be read by other users. Run "chmod 600 ${secretPath}".`);
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
  else {
    const targets = launcherTargets(await readFile(String(manifest.path), "utf8"));
    if (targets.length !== 2) problems.push(`${String(manifest.path)} is not a foxbridge launcher. Run "foxbridge install".`);
    for (const file of targets) if (!(await stat(file).catch(() => null))) problems.push(`The launcher runs ${file}, and that file does not exist. Run "foxbridge install" again.`);
  }
  return { ok: problems.length === 0, manifestPath, problems };
}
