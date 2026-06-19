import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { clearLogs, logFile, readLogs, writeLog } from "./log.js";
import {
  KV_PREFIX,
  PLUGIN_ID,
  PLUGIN_TITLE,
} from "./lib/identity.js";
import {
  buildMacTerminalCommand,
  commandLaunch,
  linuxTerminalLaunch,
  resolveOpenCodeCommand,
} from "./lib/opencode-cli.js";
import {
  ensureBrowserLauncher,
  ensureCommandRedirect,
  firstAvailableCommand,
  uninstallPlugin,
  uninstallSelf,
} from "./lib/browser-install.js";
import {
  errorMessage,
  listSessions,
  normalizeModelObject,
} from "./lib/opencode-session.js";
import { inferPluginName, inferSkillScope, normalizeMcpServer } from "./lib/browser-diagnostics.js";
import { createRequestHandler } from "./lib/browser-routes.js";
import { resolveStaticTarget } from "./lib/static-files.js";

const id = PLUGIN_ID;
const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const cliMode = process.env.OPENCODE_HISTORY_CLI === "1";
const configuredIdleMs = Number.parseInt(process.env.OPENCODE_HISTORY_BROWSER_IDLE_MS || "", 10);
const browserIdleMs = Number.isFinite(configuredIdleMs) && configuredIdleMs >= 500 ? configuredIdleMs : 45_000;
let server;
let serverUrl;
let serverToken;
let serverIdleTimer;
let lastBrowserSeen = 0;
let shutdownHandlersRegistered = false;
const serverSockets = new Set();
let requestHandler;

async function tui(api) {
  if (!cliMode) {
    registerShutdownHandlers();
    ensureBrowserLauncher({ root, writeLog }).catch((error) => writeLog("error", "launcher.install.failed", { error }));
    ensureCommandRedirect({ writeLog }).catch((error) => writeLog("error", "redirect.install.failed", { error }));
  }
  const start = async () => {
    serverUrl = await ensureServer(api);
    openUrl(serverUrl);
    api.ui.toast({
      variant: "success",
      title: PLUGIN_TITLE,
      message: `Opened ${serverUrl}`,
      duration: 3500,
    });
  };
  const safeStart = () => {
    start().catch((error) => {
      writeLog("error", "browser.start.failed", { error });
      api.ui.toast({
        variant: "error",
        title: `${PLUGIN_TITLE} failed`,
        message: errorMessage(error),
        duration: 7000,
      });
    });
  };

  api.command.register(() => [
    {
      title: `Open ${PLUGIN_TITLE}`,
      value: `${id}.open`,
      description: "Browse, pin, rename, delete, and continue OpenCode chats.",
      category: "History",
      slash: {
        name: "history-browser-next",
        aliases: ["history-ui-next"],
      },
      onSelect: safeStart,
    },
    {
      title: `Uninstall ${PLUGIN_TITLE}`,
      value: `${id}.uninstall`,
      description: "Remove this plugin from OpenCode TUI config.",
      category: "History",
      slash: {
        name: "history-browser-next-uninstall",
      },
      onSelect: () => uninstallSelf({ api, uninstallPlugin }),
    },
    {
      title: `Check ${PLUGIN_TITLE} Install`,
      value: `${id}.doctor`,
      description: "Verify that the browser plugin can start and read OpenCode sessions.",
      category: "History",
      slash: {
        name: "history-browser-next-doctor",
      },
      onSelect: () => runDoctor(api),
    },
  ]);

  if (!cliMode) setTimeout(safeStart, 1000);
}

async function ensureServer(api) {
  if (server?.listening && serverUrl) return serverUrl;

  lastBrowserSeen = Date.now();
  requestHandler = requestHandler || createRequestHandler({
    api,
    logFile,
    readLogs,
    clearLogs,
    writeLog,
    errorMessage,
    assertOk,
    sendJson,
    readJson,
    serveStatic,
    isAuthorized,
    markBrowserSeen,
    getPinned: () => getPinned(api),
    setPinned: (sessionID, pinned) => setPinned(api, sessionID, pinned),
    removePinned: (sessionID) => removePinned(api, sessionID),
    openTuiPanel: (action) => openTuiPanel(api, action),
    openOpenCodeTerminal,
    uninstallPlugin,
    normalizeModelObject,
    mapSkill: (skill) => ({
      name: skill.name,
      description: skill.description,
      location: skill.location,
      plugin: inferPluginName(skill),
      scope: inferSkillScope(skill),
    }),
    normalizeMcpServer,
  });
  server = createServer((request, response) => {
    requestHandler(request, response).catch((error) => {
      writeLog("error", "request.failed", {
        method: request.method,
        path: String(request.url || "").replace(/([?&]token=)[^&]+/i, "$1[redacted]"),
        error,
      });
      sendJson(response, { error: errorMessage(error) }, error.statusCode || 500);
    });
  });
  server.on("connection", (socket) => {
    serverSockets.add(socket);
    socket.on("close", () => serverSockets.delete(socket));
  });
  server.on("close", () => serverSockets.clear());

  const port = await listenOnAvailablePort(server, 8765);
  serverToken = randomBytes(18).toString("base64url");
  serverUrl = `http://127.0.0.1:${port}/?token=${serverToken}`;
  await writeLog("info", "browser.server.started", { port, headless: Boolean(api.headless) });
  startIdleMonitor(api);
  return serverUrl;
}

async function runDoctor(api) {
  const checks = [];
  try {
    const url = await ensureServer(api);
    checks.push(`server ok: ${url.replace(/\?.*/, "")}`);
  } catch (error) {
    checks.push(`server failed: ${errorMessage(error)}`);
  }

  checks.push(existsSync(join(publicDir, "index.html")) ? "ui files ok" : "ui files missing");

  try {
    const sessions = await listSessions(api, "", getPinned(api));
    checks.push(`sessions ok: ${sessions.length}`);
  } catch (error) {
    checks.push(`sessions failed: ${errorMessage(error)}`);
  }

  api.ui.toast({
    variant: checks.some((item) => item.includes("failed") || item.includes("missing")) ? "warning" : "success",
    title: "History Browser Doctor",
    message: checks.join(" | "),
    duration: 10000,
  });
}

async function listenOnAvailablePort(httpServer, firstPort) {
  for (let port = firstPort; port < firstPort + 20; port += 1) {
    const ok = await new Promise((resolve) => {
      const onError = () => {
        httpServer.off("error", onError);
        resolve(false);
      };
      httpServer.once("error", onError);
      httpServer.listen(port, "127.0.0.1", () => {
        httpServer.off("error", onError);
        resolve(true);
      });
    });
    if (ok) return port;
  }
  throw new Error("No available local port for history browser.");
}

async function openTuiPanel(api, action) {
  const method = {
    help: "openHelp",
    models: "openModels",
    sessions: "openSessions",
    themes: "openThemes",
  }[action];
  if (!method || !api.client.tui?.[method]) throw new Error(`Unsupported OpenCode panel: ${action}`);
  await assertOk(api.client.tui[method]({}));
}

function getPinned(api) {
  const value = api.kv.get(`${KV_PREFIX}pinned`, []);
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function setPinned(api, sessionID, pinned) {
  const next = getPinned(api).filter((item) => item !== sessionID);
  if (pinned) next.unshift(sessionID);
  api.kv.set(`${KV_PREFIX}pinned`, next);
}

function removePinned(api, sessionID) {
  api.kv.set(`${KV_PREFIX}pinned`, getPinned(api).filter((item) => item !== sessionID));
}

async function serveStatic(response, requestPath) {
  const target = resolveStaticTarget(publicDir, requestPath);
  if (!target || !existsSync(target)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const content = await readFile(target);
  response.writeHead(200, {
    "content-type": mimeType(target),
    "cache-control": "no-store",
    "set-cookie": `history_browser_token=${serverToken}; Path=/; SameSite=Strict`,
  });
  response.end(content);
}

async function readJson(request) {
  const maxBytes = 64 * 1024 * 1024;
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > maxBytes) throw httpError(413, "Request body is too large.");
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw httpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Invalid JSON request body.");
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function assertOk(promise) {
  const result = await promise;
  if (result?.error) throw new Error(errorMessage(result.error));
  return result?.data;
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function mimeType(path) {
  if (extname(path) === ".css") return "text/css; charset=utf-8";
  if (extname(path) === ".js") return "application/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

function isAuthorized(request, url) {
  if (!serverToken) return false;
  const header = request.headers["x-history-browser-token"];
  const cookie = String(request.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("history_browser_token="))
    ?.slice("history_browser_token=".length);
  return header === serverToken || url.searchParams.get("token") === serverToken || cookie === serverToken;
}

function markBrowserSeen() {
  lastBrowserSeen = Date.now();
}

function startIdleMonitor(api) {
  if (serverIdleTimer) clearInterval(serverIdleTimer);
  const pollMs = Math.min(15_000, Math.max(500, Math.floor(browserIdleMs / 2)));
  serverIdleTimer = setInterval(() => {
    if (!server?.listening) {
      closeServer();
      return;
    }
    if (api.headless && Date.now() - lastBrowserSeen > browserIdleMs) {
      writeLog("info", "browser.idle.shutdown", { idleMs: Date.now() - lastBrowserSeen }).finally(() => {
        closeServer();
        if (typeof api.shutdown === "function") api.shutdown();
        else process.exit(0);
      });
    }
  }, pollMs);
  serverIdleTimer.unref?.();
}

function closeServer() {
  if (serverIdleTimer) {
    clearInterval(serverIdleTimer);
    serverIdleTimer = undefined;
  }
  for (const socket of serverSockets) socket.destroy();
  serverSockets.clear();
  if (server?.listening) server.close();
  server = undefined;
  serverUrl = undefined;
  serverToken = undefined;
  lastBrowserSeen = 0;
}

function registerShutdownHandlers() {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  process.once("exit", closeServer);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      closeServer();
      process.exit(0);
    });
  }
}

function openUrl(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function openOpenCodeTerminal({ directory, sessionID, preferredCommand }) {
  const args = ["--dir", directory, ...(sessionID ? ["--session", sessionID] : [])];
  if (process.platform === "win32") {
    const command = await resolveOpenCodeCommand(preferredCommand);
    const cwd = existsSync(directory) ? directory : homedir();
    const env = { ...process.env, OPENCODE_HISTORY_CLI: "1" };
    const launch = commandLaunch(command, args, "keep");
    await writeLog("info", "cli.open", { command, args, cwd, terminal: launch.command });
    await spawnVisible(launch.command, launch.args, { cwd, env });
    return;
  }
  const command = await resolveOpenCodeCommand(preferredCommand);
  const cwd = existsSync(directory) ? directory : homedir();
  const env = { ...process.env, OPENCODE_HISTORY_CLI: "1" };
  if (process.platform === "darwin") {
    const shellCommand = buildMacTerminalCommand(command, args, cwd);
    const script = `tell application "Terminal" to do script "${appleScriptQuote(shellCommand)}"`;
    await spawnVisible("osascript", ["-e", script], { cwd, env });
    return;
  }
  const terminalCandidates = [
    process.env.TERMINAL,
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "xterm",
  ].filter(Boolean);
  const terminal = await firstAvailableCommand(terminalCandidates);
  if (!terminal) throw new Error("No supported terminal emulator was found. Set the TERMINAL environment variable.");
  const launch = linuxTerminalLaunch(terminal, command, args);
  await spawnVisible(launch.command, launch.args, { cwd, env });
}

function appleScriptQuote(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function spawnVisible(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      writeLog("info", "process.spawned", { command, args, pid: child.pid }).catch(() => {});
      child.unref();
      resolve();
    });
  });
}


async function startBrowserHost(api) {
  registerShutdownHandlers();
  const url = await ensureServer(api);
  if (process.env.OPENCODE_HISTORY_BROWSER_NO_OPEN !== "1") openUrl(url);
  return { url, close: closeServer };
}

export {
  ensureBrowserLauncher,
  ensureCommandRedirect,
  inferPluginName,
  inferSkillScope,
  normalizeMcpServer,
  startBrowserHost,
};
export default { id, tui };
