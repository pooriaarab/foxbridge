// I1-I7 in docs/failure-modes.md: the native messaging host manifest and
// the launcher that Firefox starts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTENSION_ID, FoxbridgeError, HOST_NAME, install, manifestDir, status, uninstall } from "../src/index.js";

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fbr-home-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const posix = { platform: "linux" as const, nodePath: process.execPath, cliPath: "/opt/foxbridge/dist/cli.js" };

describe("manifest place", () => {
  it("uses the per-user folders that Firefox reads", () => {
    expect(manifestDir("darwin", "/Users/sam")).toBe("/Users/sam/Library/Application Support/Mozilla/NativeMessagingHosts");
    expect(manifestDir("linux", "/home/sam")).toBe("/home/sam/.mozilla/native-messaging-hosts");
  });

  it("I4: throws unsupported-platform for a platform with no known place", () => {
    let code = "";
    try {
      manifestDir("aix", home);
    } catch (error) {
      code = error instanceof FoxbridgeError ? error.code : "other";
    }
    expect(code).toBe("unsupported-platform");
  });
});

describe("install", () => {
  it("I6, I2: writes an absolute launcher path, the name foxbridge, and only the foxbridge extension id", async () => {
    const result = await install({ home, ...posix });
    expect(result.manifestPath).toBe(join(home, ".mozilla/native-messaging-hosts/foxbridge.json"));
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(manifest.name).toBe(HOST_NAME);
    expect(HOST_NAME).toMatch(/^\w+(\.\w+)*$/);
    expect(manifest.type).toBe("stdio");
    expect(manifest.allowed_extensions).toEqual([EXTENSION_ID]);
    expect(isAbsolute(manifest.path)).toBe(true);
    expect(manifest.path).toBe(result.launcherPath);
    expect(statSync(result.launcherPath).mode & 0o111).not.toBe(0);
  });

  it("I6: the launcher runs Node with the CLI and `host`, and passes the Firefox arguments on", async () => {
    const dir = mkdtempSync(join(home, "it's a dir "));
    const cliPath = join(dir, "cli.mjs");
    writeFileSync(cliPath, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    const { launcherPath } = await install({ home, platform: process.platform === "win32" ? "linux" : process.platform, nodePath: process.execPath, cliPath });
    if (process.platform === "win32") return;
    const out = execFileSync(launcherPath, ["/path/to/foxbridge.json", "foxbridge@pooriaarab"], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual(["host", "/path/to/foxbridge.json", "foxbridge@pooriaarab"]);
  });

  it("I3: warns when the CLI runs from an npx cache", async () => {
    const result = await install({ home, ...posix, cliPath: "/Users/sam/.npm/_npx/1a2b/node_modules/foxbridge/dist/cli.js" });
    expect(result.warnings.join(" ")).toMatch(/npx/);
    const clean = await install({ home, ...posix });
    expect(clean.warnings).toEqual([]);
  });

  it("I7: on Windows, writes the registry key that points to the manifest", async () => {
    const calls: string[][] = [];
    const result = await install({ home, platform: "win32", nodePath: "C:\\node\\node.exe", cliPath: "C:\\fb\\dist\\cli.js", reg: async (args) => void calls.push(args) });
    expect(result.launcherPath.endsWith(".cmd")).toBe(true);
    expect(calls).toEqual([["add", "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\foxbridge", "/ve", "/t", "REG_SZ", "/d", result.manifestPath, "/f"]]);
    const removed: string[][] = [];
    await uninstall({ home, platform: "win32", reg: async (args) => void removed.push(args) });
    expect(removed).toEqual([["delete", "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\foxbridge", "/f"]]);
  });
});

describe("status", () => {
  it("is ok right after install", async () => {
    await install({ home, ...posix });
    expect(await status({ home, platform: "linux" })).toMatchObject({ ok: true, problems: [] });
  });

  it("says when nothing is installed", async () => {
    const result = await status({ home, platform: "linux" });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/foxbridge install/);
  });

  it("I1: names the missing launcher", async () => {
    const { launcherPath } = await install({ home, ...posix });
    rmSync(launcherPath);
    const result = await status({ home, platform: "linux" });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain(launcherPath);
  });

  it("I2: names an extension id that is not the foxbridge one", async () => {
    const { manifestPath } = await install({ home, ...posix, extensionId: "someone@else" });
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).allowed_extensions).toEqual(["someone@else"]);
    const result = await status({ home, platform: "linux" });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("someone@else");
  });
});

describe("uninstall", () => {
  it("removes the manifest and the launcher", async () => {
    const { manifestPath, launcherPath } = await install({ home, ...posix });
    const { removed } = await uninstall({ home, platform: "linux" });
    expect(removed.toSorted()).toEqual([launcherPath, manifestPath].toSorted());
    expect(existsSync(manifestPath) || existsSync(launcherPath)).toBe(false);
  });

  it("I5: removes nothing and does not throw when nothing is installed", async () => {
    expect(await uninstall({ home, platform: "linux" })).toEqual({ removed: [] });
  });
});
