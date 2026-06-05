import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { startBrowserHost } from "./tui.js";

const configDir = join(homedir(), ".config", "opencode");
const kvFile = join(configDir, "history-browser-kv.json");
const port = await availablePort(4096);
const child = spawn(resolveOpenCode(), ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
  cwd: process.cwd(),
  env: process.env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});

await waitForServer(child, port);
const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
const store = await readStore();
await startBrowserHost({
  client,
  headless: true,
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

let closing = false;
function closeAll() {
  if (closing) return;
  closing = true;
  child.kill();
}

process.once("exit", closeAll);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    closeAll();
    process.exit(0);
  });
}
child.once("exit", () => process.exit(0));

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
