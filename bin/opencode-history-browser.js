#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const app = join(root, "app.py");
const home = process.env.USERPROFILE || process.env.HOME || "";
const defaultDb = join(home, ".local", "share", "opencode", "opencode.db");
const url = `http://127.0.0.1:${process.env.PORT || "8765"}`;

const args = new Set(process.argv.slice(2));
const python = findPython();

if (args.has("--doctor")) {
  doctor();
  process.exit(0);
}

if (!python) {
  console.error("Python 3 was not found. Install Python, or set PYTHON to the full python.exe path.");
  console.error("Then run: opencode-history-browser --doctor");
  process.exit(1);
}

if (!existsSync(process.env.OPENCODE_DB || defaultDb)) {
  console.error("OpenCode database was not found.");
  console.error(`Expected: ${process.env.OPENCODE_DB || defaultDb}`);
  console.error("Open OpenCode once on this computer first, or set OPENCODE_DB to the database path.");
  process.exit(1);
}

if (!args.has("--no-open")) {
  setTimeout(() => openUrl(url), 900);
}

console.log(`OpenCode History Browser: ${url}`);
console.log("Press Ctrl+C to stop.");

const child = spawn(python.command, [...python.args, app], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push({ command: process.env.PYTHON, args: [] });
  candidates.push({ command: "python", args: [] });
  candidates.push({ command: "py", args: ["-3"] });

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args, "--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return undefined;
}

function doctor() {
  console.log("OpenCode History Browser doctor");
  console.log("");
  console.log(`Package: ${root}`);
  console.log(`Python: ${python ? `${python.command} ${python.args.join(" ")}`.trim() : "not found"}`);
  console.log(`Database: ${process.env.OPENCODE_DB || defaultDb}`);
  console.log(`Database exists: ${existsSync(process.env.OPENCODE_DB || defaultDb) ? "yes" : "no"}`);
  console.log(`URL: ${url}`);
  console.log("");
  console.log("If Database exists is 'no', open OpenCode once on this computer first.");
}

function openUrl(target) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
}
