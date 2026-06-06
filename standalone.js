import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { startBrowserHost } from "./tui.js";

const configDir = join(homedir(), ".config", "opencode");
const kvFile = join(configDir, "history-browser-kv.json");
const lockFile = join(configDir, "history-browser.lock");
await mkdir(configDir, { recursive: true });
const lock = await acquireInstanceLock();
if (!lock) process.exit(0);
const port = await availablePort(4096);
const opencodeCommand = resolveOpenCode();
const child = spawn(opencodeCommand, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
  cwd: process.cwd(),
  env: process.env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

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

function resolveOpenCode() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    const executable = join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (existsSync(executable)) return executable;
  }
  return "opencode";
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
    const timer = setTimeout(() => reject(new Error("Timed out starting OpenCode server.")), 12000);
    let output = "";
    const inspect = (chunk) => {
      output += chunk.toString();
      if (!output.includes(`127.0.0.1:${targetPort}`)) return;
      clearTimeout(timer);
      resolve();
    };
    processHandle.stdout.on("data", inspect);
    processHandle.stderr.on("data", inspect);
    processHandle.once("error", reject);
    processHandle.once("exit", (code) => reject(new Error(`OpenCode server exited with code ${code}.`)));
  });
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
