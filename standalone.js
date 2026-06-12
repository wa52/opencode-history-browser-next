import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { startBrowserHost } from "./tui.js";
import { writeLog } from "./log.js";
import { CONFIG_DIR, KV_FILE, LOCK_FILE } from "./lib/identity.js";
import { createCleanupOnce } from "./lib/cleanup.js";
import { commandLaunch, resolveOpenCodeCommand } from "./lib/opencode-cli.js";
import { stopProcessTree, stopProcessTreeSync } from "./lib/process-tree.js";
import { createWriteQueue } from "./lib/write-queue.js";

const storeQueue = createWriteQueue(writeStore);
let lock;
let child;
let fatalError = false;
const closeAll = createCleanupOnce(async () => {
  await storeQueue.flush().catch((error) => writeLog("error", "store.flush.failed", { error }));
  await lock?.close().catch(() => {});
  lock = undefined;
  try {
    unlinkSync(LOCK_FILE);
  } catch {}
  await stopProcessTree(child?.pid);
});
process.on("uncaughtException", (error) => handleFatalError("standalone.uncaught", error));
process.on("unhandledRejection", (error) => handleFatalError("standalone.unhandled", error));
await mkdir(CONFIG_DIR, { recursive: true });
await writeLog("info", "standalone.start", {
  platform: process.platform,
  node: process.execPath,
  cwd: process.cwd(),
});
lock = await acquireInstanceLock();
if (!lock) process.exit(0);
const port = await availablePort(4096);
const opencodeCommand = await resolveOpenCodeCommand();
const launch = commandLaunch(opencodeCommand, ["serve", "--hostname=127.0.0.1", `--port=${port}`]);
await writeLog("info", "opencode.serve.start", { command: launch.command, args: launch.args, port });
child = spawn(launch.command, launch.args, {
  cwd: process.cwd(),
  env: { ...process.env, OPENCODE_HISTORY_CLI: "1" },
  detached: process.platform !== "win32",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
registerCleanupHandlers();
if (process.env.OPENCODE_HISTORY_BROWSER_FAIL_AFTER_SPAWN === "1") {
  const delay = Number.parseInt(process.env.OPENCODE_HISTORY_BROWSER_FAIL_DELAY_MS || "", 10);
  if (Number.isFinite(delay) && delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("Injected startup failure after OpenCode spawn.");
}

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
  async shutdown() {
    await closeAll();
    process.exit(0);
  },
  kv: {
    get(key, fallback) {
      return key in store ? store[key] : fallback;
    },
    set(key, value) {
      store[key] = value;
      storeQueue.enqueue(store).catch((error) => writeLog("error", "store.write.failed", { error }));
    },
  },
});
await writeLog("info", "standalone.ready", { opencodeUrl, browserUrl: browserHost.url.replace(/\?.*/, "") });
await lock.truncate(0);
await lock.writeFile(JSON.stringify({ url: browserHost.url, pid: process.pid }), "utf8");
await lock.close();
lock = undefined;

async function handleFatalError(event, error) {
  if (fatalError) return;
  fatalError = true;
  await writeLog("error", event, { error }).catch(() => {});
  await closeAll().catch(() => {});
  process.exit(1);
}

function registerCleanupHandlers() {
  process.once("exit", () => {
    try {
      unlinkSync(LOCK_FILE);
    } catch {}
    stopProcessTreeSync(child?.pid);
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, async () => {
      await closeAll();
      process.exit(0);
    });
  }
  child.once("exit", async () => {
    await closeAll();
    process.exit(0);
  });
}

async function acquireInstanceLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await open(LOCK_FILE, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await waitForExistingBrowser();
      if (existing) {
        openBrowser(existing);
        return undefined;
      }
      await unlink(LOCK_FILE).catch(() => {});
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
    const value = JSON.parse(await readFile(LOCK_FILE, "utf8"));
    if (!value?.url) return "";
    const response = await fetch(new URL("/api/health", value.url), { signal: AbortSignal.timeout(2500) });
    const data = await response.json();
    return response.ok && data?.ok ? value.url : "";
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
      const error = new Error("Timed out starting OpenCode server. See history-browser-next.log.");
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
    return JSON.parse(await readFile(KV_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeStore(value) {
  await mkdir(CONFIG_DIR, { recursive: true });
  const temporary = `${KV_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, KV_FILE);
}
