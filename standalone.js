import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { startBrowserHost } from "./tui.js";
import { writeLog } from "./log.js";

const configDir = join(homedir(), ".config", "opencode");
const kvFile = join(configDir, "history-browser-kv.json");
const lockFile = join(configDir, "history-browser.lock");
const execFileAsync = promisify(execFile);
process.on("uncaughtException", async (error) => {
  await writeLog("error", "standalone.uncaught", { error });
  process.exit(1);
});
process.on("unhandledRejection", async (error) => {
  await writeLog("error", "standalone.unhandled", { error });
  process.exit(1);
});
await mkdir(configDir, { recursive: true });
await writeLog("info", "standalone.start", {
  platform: process.platform,
  node: process.execPath,
  cwd: process.cwd(),
});
const lock = await acquireInstanceLock();
if (!lock) process.exit(0);
const port = await availablePort(4096);
const opencodeCommand = await resolveOpenCode();
const launch = commandLaunch(opencodeCommand, ["serve", "--hostname=127.0.0.1", `--port=${port}`]);
await writeLog("info", "opencode.serve.start", { command: launch.command, args: launch.args, port });
const child = spawn(launch.command, launch.args, {
  cwd: process.cwd(),
  env: { ...process.env, OPENCODE_HISTORY_CLI: "1" },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => writeLog("info", "opencode.stdout", { text: clipOutput(chunk) }));
child.stderr.on("data", (chunk) => writeLog("error", "opencode.stderr", { text: clipOutput(chunk) }));
child.once("error", (error) => writeLog("error", "opencode.spawn.failed", { error, command: launch.command, args: launch.args }));
child.once("exit", (code, signal) => writeLog("info", "opencode.serve.exit", { code, signal }));

await waitForServer(child, port);
const opencodeUrl = `http://127.0.0.1:${port}`;
const client = createOpencodeClient({ baseUrl: opencodeUrl });
const store = await readStore();
const browserHost = await startBrowserHost({
  client,
  headless: true,
  opencodeUrl,
  opencodeCommand,
  kv: {
    get(key, fallback) {
      return key in store ? store[key] : fallback;
    },
    set(key, value) {
      store[key] = value;
      writeStore(store).catch(() => {});
    },
  },
});
await writeLog("info", "standalone.ready", { opencodeUrl, browserUrl: browserHost.url.replace(/\?.*/, "") });
await lock.truncate(0);
await lock.writeFile(JSON.stringify({ url: browserHost.url, pid: process.pid }), "utf8");

let closing = false;
function closeAll() {
  if (closing) return;
  closing = true;
  child.kill();
  lock.close().catch(() => {});
  unlink(lockFile).catch(() => {});
}

process.once("exit", closeAll);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    closeAll();
    process.exit(0);
  });
}
child.once("exit", () => process.exit(0));

async function acquireInstanceLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await open(lockFile, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await waitForExistingBrowser();
      if (existing) {
        openBrowser(existing);
        return undefined;
      }
      await unlink(lockFile).catch(() => {});
    }
  }
  throw new Error("Could not acquire the OpenCode browser lock.");
}

async function waitForExistingBrowser() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const url = await existingBrowserUrl();
    if (url) return url;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return "";
}

async function existingBrowserUrl() {
  try {
    const value = JSON.parse(await readFile(lockFile, "utf8"));
    if (!value?.url) return "";
    const response = await fetch(new URL("/api/health", value.url), { signal: AbortSignal.timeout(2500) });
    const data = await response.json();
    return response.ok && data?.ok ? (data.url || value.url) : "";
  } catch {
    return "";
  }
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/d", "/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
}

async function resolveOpenCode() {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const candidates = process.platform === "win32"
    ? [
        process.env.OPENCODE_BINARY,
        join(appData, "npm", "opencode-cli.cmd"),
        join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
        join(appData, "npm", "opencode.exe"),
        "opencode-cli.cmd",
        "opencode.exe",
        "opencode.cmd",
      ]
    : [process.env.OPENCODE_BINARY, "opencode"];
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    if (!isOpenCodeCommand(candidate)) continue;
    if (isAbsolute(candidate) && existsSync(candidate)) {
      await writeLog("info", "opencode.command.resolved", { command: candidate, source: "file" });
      return candidate;
    }
    if (!isAbsolute(candidate) && await commandExists(candidate)) {
      await writeLog("info", "opencode.command.resolved", { command: candidate, source: "path" });
      return candidate;
    }
  }
  throw new Error("OpenCode CLI executable was not found. Run `where opencode` and reinstall the plugin.");
}

function commandLaunch(command, args) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return { command: "cmd.exe", args: ["/d", "/c", "call", command, ...args] };
  }
  return { command, args };
}

function isOpenCodeCommand(command) {
  return typeof command === "string" &&
    /(?:^|[\\/])opencode(?:-cli)?(?:\.(?:exe|cmd|bat))?$/i.test(command.trim());
}

async function commandExists(command) {
  try {
    await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [command], {
      timeout: 5000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function availablePort(start) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(availablePort(start + 1)));
    probe.once("listening", () => probe.close(() => resolve(start)));
    probe.listen(start, "127.0.0.1");
  });
}

function waitForServer(processHandle, targetPort) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(timer);
      callback(value);
    };
    const poller = setInterval(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${targetPort}/global/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) finish(resolve);
      } catch {}
    }, 300);
    const timer = setTimeout(() => {
      const error = new Error("Timed out starting OpenCode server. See history-browser.log.");
      writeLog("error", "opencode.serve.timeout", { port: targetPort, error });
      finish(reject, error);
    }, 20000);
    processHandle.once("error", (error) => finish(reject, error));
    processHandle.once("exit", (code) => finish(reject, new Error(`OpenCode server exited with code ${code}.`)));
  });
}

function clipOutput(chunk) {
  const value = String(chunk || "").trim();
  return value.length > 4000 ? `${value.slice(0, 4000)}...` : value;
}

async function readStore() {
  try {
    return JSON.parse(await readFile(kvFile, "utf8"));
  } catch {
    return {};
  }
}

async function writeStore(value) {
  await mkdir(configDir, { recursive: true });
  await writeFile(kvFile, JSON.stringify(value, null, 2), "utf8");
}
