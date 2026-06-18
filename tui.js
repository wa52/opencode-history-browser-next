import { createServer } from "node:http";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { clearLogs, logFile, readLogs, writeLog } from "./log.js";
import {
  KV_PREFIX,
  LAUNCHER_FILE,
  LAUNCHER_NAME,
  PLUGIN_ID,
  PLUGIN_TITLE,
  REDIRECT_BACKUP_BASENAME,
  REDIRECT_MARKER,
  REPOSITORY_SPEC,
} from "./lib/identity.js";
import {
  buildMacTerminalCommand,
  commandExists,
  commandLaunch,
  linuxTerminalLaunch,
  resolveOpenCodeCommand,
} from "./lib/opencode-cli.js";
import { buildBalancedSnapshot } from "./lib/browser-snapshot.js";
import { inferPluginName, inferSkillScope, normalizeMcpServer } from "./lib/browser-diagnostics.js";
import { resolveStaticTarget } from "./lib/static-files.js";
import { buildBackupForwarder, hasForeignHistoryRedirect, ownsRedirect } from "./lib/redirect.js";

const id = PLUGIN_ID;
const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const execFileAsync = promisify(execFile);
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

async function tui(api) {
  if (!cliMode) {
    registerShutdownHandlers();
    ensureBrowserLauncher().catch((error) => writeLog("error", "launcher.install.failed", { error }));
    ensureCommandRedirect().catch((error) => writeLog("error", "redirect.install.failed", { error }));
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
      onSelect: () => uninstallSelf(api),
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
  server = createServer((request, response) => {
    handleRequest(api, request, response).catch((error) => {
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
    const sessions = await listSessions(api, "");
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

async function handleRequest(api, request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, { ok: true });
  }
  if (url.pathname.startsWith("/api/") && !isAuthorized(request, url)) {
    return sendJson(response, { error: "Unauthorized history browser request" }, 401);
  }
  if (url.pathname.startsWith("/api/")) markBrowserSeen();

  if (request.method === "POST" && url.pathname === "/api/heartbeat") {
    return sendJson(response, { ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/browser-close") {
    lastBrowserSeen = Date.now();
    return sendJson(response, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const query = url.searchParams.get("q") || "";
    const sessions = await listSessions(api, query);
    return sendJson(response, { sessions });
  }

  if (request.method === "GET" && url.pathname === "/api/models") {
    const models = await listModels(api);
    return sendJson(response, { models });
  }

  if (request.method === "GET" && url.pathname === "/api/permissions") {
    const permissions = await listPermissions(api);
    return sendJson(response, { permissions });
  }

  if (request.method === "GET" && url.pathname === "/api/questions") {
    const questions = await listQuestions(api);
    return sendJson(response, { questions });
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/questions/")) {
    const suffix = url.pathname.slice("/api/questions/".length);
    const requestID = decodeURIComponent(suffix.replace(/\/(reply|reject)$/, ""));
    if (suffix.endsWith("/reject")) {
      await assertOk(api.client.question.reject({ requestID }));
      return sendJson(response, { ok: true });
    }
    if (!suffix.endsWith("/reply")) return sendJson(response, { error: "Unknown question action" }, 404);
    const body = await readJson(request);
    const answers = Array.isArray(body.answers) ? body.answers.map((answer) => Array.isArray(answer) ? answer.map(String) : []) : [];
    await assertOk(api.client.question.reply({ requestID, answers }));
    return sendJson(response, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/skills") {
    const skills = await assertOk(api.client.app.skills({}));
    return sendJson(response, {
      skills: (Array.isArray(skills) ? skills : []).map((skill) => ({
        name: skill.name,
        description: skill.description,
        location: skill.location,
        plugin: inferPluginName(skill),
        scope: inferSkillScope(skill),
      })),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/mcp") {
    const status = await assertOk(api.client.mcp.status({}));
    return sendJson(response, { servers: Object.entries(status || {}).map(([name, value]) => normalizeMcpServer(name, value)) });
  }

  if (request.method === "GET" && url.pathname === "/api/logs") {
    return sendJson(response, { path: logFile, content: await readLogs() });
  }

  if (request.method === "POST" && url.pathname === "/api/logs/open") {
    await openLocalPath(logFile, "file");
    return sendJson(response, { ok: true, path: logFile });
  }

  if (request.method === "POST" && url.pathname === "/api/logs/clear") {
    await clearLogs();
    await writeLog("info", "logs.cleared");
    return sendJson(response, { ok: true, path: logFile });
  }

  if (request.method === "POST" && url.pathname === "/api/uninstall") {
    const result = await uninstallPlugin();
    await writeLog("info", "plugin.uninstalled", result);
    return sendJson(response, { ok: true, ...result });
  }

  if (request.method === "POST" && url.pathname === "/api/open-terminal") {
    const body = await readJson(request);
    const sessionID = String(body.sessionID || "").trim();
    let directory = process.cwd();
    if (sessionID) {
      const result = await api.client.session.get({ sessionID });
      if (result.error || !result.data) return sendJson(response, { error: "Session not found" }, 404);
      directory = result.data.directory || directory;
    }
    try {
      await openOpenCodeTerminal({
        directory,
        sessionID,
        preferredCommand: api.opencodeCommand,
      });
    } catch (error) {
      await writeLog("error", "cli.open.failed", {
        directory,
        sessionID,
        serverUrl: api.opencodeUrl,
        preferredCommand: api.opencodeCommand,
        error,
      });
      throw error;
    }
    return sendJson(response, { ok: true, sessionID, directory });
  }

  if (request.method === "POST" && url.pathname === "/api/local-path") {
    const body = await readJson(request);
    const target = normalizeLocalPath(body.path);
    const action = String(body.action || "info");
    if (!target || !isAbsolute(target)) return sendJson(response, { error: "A valid absolute local path is required." }, 400);
    const info = await localPathInfo(target, true);
    if (!info.exists) return sendJson(response, { error: "The local path no longer exists.", path: target }, 404);
    if (action === "open") await openLocalPath(target, info.type);
    else if (action === "locate") {
      if (info.type === "file") await revealLocalFile(target);
      else await openLocalPath(target, info.type);
    } else if (action !== "info") {
      return sendJson(response, { error: "Unknown local path action." }, 400);
    }
    return sendJson(response, { ok: true, path: target, type: info.type });
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/permissions/")) {
    const requestID = decodeURIComponent(url.pathname.slice("/api/permissions/".length).replace(/\/reply$/, ""));
    const body = await readJson(request);
    const reply = ["once", "always", "reject"].includes(body.reply) ? body.reply : "";
    if (!requestID || !reply) return sendJson(response, { error: "Invalid permission reply" }, 400);
    await assertOk(api.client.permission.reply({ requestID, reply }));
    return sendJson(response, { ok: true, requestID, reply });
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const sessionID = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
    const session = await getSession(api, sessionID);
    if (!session) return sendJson(response, { error: "Session not found" }, 404);
    return sendJson(response, { session });
  }

  if (request.method === "POST" && url.pathname === "/api/sessions/delete") {
    const body = await readJson(request);
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((item) => typeof item === "string"))] : [];
    const results = [];
    for (const sessionID of ids) {
      try {
        await assertOk(api.client.session.delete({ sessionID }));
        removePinned(api, sessionID);
        results.push({ id: sessionID, ok: true });
      } catch (error) {
        results.push({ id: sessionID, ok: false, error: errorMessage(error) });
      }
    }
    return sendJson(response, { ok: results.every((item) => item.ok), results });
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/tui/")) {
    const action = url.pathname.slice("/api/tui/".length);
    await openTuiPanel(api, action);
    return sendJson(response, { ok: true, action });
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/sessions/")) {
    const [, sessionID, action] = matchSessionAction(url.pathname);
    if (action === "rename") {
      const body = await readJson(request);
      await assertOk(api.client.session.update({ sessionID, title: String(body.title || "").trim() }));
      return sendJson(response, { ok: true });
    }
    if (action === "pin") {
      const body = await readJson(request);
      setPinned(api, sessionID, Boolean(body.pinned));
      return sendJson(response, { ok: true });
    }
    if (action === "delete") {
      await assertOk(api.client.session.delete({ sessionID }));
      removePinned(api, sessionID);
      return sendJson(response, { ok: true });
    }
    if (action === "snapshot") {
      const session = await getSession(api, sessionID);
      if (!session) return sendJson(response, { error: "Session not found" }, 404);
      const snapshot = buildBalancedSnapshot(session);
      const created = await assertOk(api.client.session.create({ title: `Snapshot - ${session.title || "Untitled"}` }));
      const newSessionID = created?.id;
      if (!newSessionID) throw new Error("Snapshot session was not created.");
      await assertOk(api.client.session.prompt({
        sessionID: newSessionID,
        noReply: true,
        parts: [{ type: "text", text: snapshot }],
      }));
      if (!api.headless) await assertOk(api.client.tui.selectSession({ sessionID: newSessionID }));
      return sendJson(response, { ok: true, sessionID: newSessionID });
    }
    if (action === "open") {
      if (!api.headless) await assertOk(api.client.tui.selectSession({ sessionID }));
      return sendJson(response, { ok: true, command: `opencode --session ${sessionID}` });
    }
    if (action === "abort") {
      await assertOk(api.client.session.abort({ sessionID }));
      return sendJson(response, { ok: true, sessionID });
    }
    if (action === "prompt") {
      const body = await readJson(request);
      const text = String(body.text || "").trim();
      const files = normalizePromptFiles(body.files);
      if (!text && !files.length) return sendJson(response, { error: "Message is empty" }, 400);
      if (!api.headless) await assertOk(api.client.tui.selectSession({ sessionID }));
      const model = normalizeModelObject(body.model);
      const result = await promptSession(api, { sessionID, text, model, files });
      return sendJson(response, { ok: true, sessionID, method: result.method, model: result.model });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/open-new") {
    const result = await assertOk(api.client.session.create({ title: "New chat" }));
    const sessionID = result?.id;
    if (sessionID && !api.headless) await assertOk(api.client.tui.selectSession({ sessionID }));
    return sendJson(response, { ok: true, command: "opencode", sessionID });
  }

  return serveStatic(response, url.pathname);
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

async function listSessions(api, search) {
  const client = api.client.experimental?.session || api.client.session;
  const result = await assertOk(client.list({ limit: 250, search: search || undefined, archived: false }));
  const pinned = getPinned(api);
  const pinnedRank = new Map(pinned.map((sessionID, index) => [sessionID, index]));
  let source = Array.isArray(result)
    ? result.filter((session) => !(session.parentID || session.parent_id))
    : [];
  if (!source.length) source = await listSessionsFromCli(search);
  const rows = await Promise.all(source.map((session) => sessionRow(api, session, pinned)));
  rows.sort((a, b) => {
    if (a.pinned && b.pinned) return pinnedRank.get(a.id) - pinnedRank.get(b.id);
    if (a.pinned) return -1;
    if (b.pinned) return 1;
    return (b.updated || 0) - (a.updated || 0);
  });
  return rows;
}

async function listSessionsFromCli(search) {
  for (const command of opencodeCommands()) {
    try {
      const { stdout } = await execFileAsync(command, ["--pure", "session", "list"], {
        timeout: 15000,
        maxBuffer: 1024 * 1024 * 4,
        windowsHide: true,
      });
      const needle = String(search || "").trim().toLowerCase();
      return stdout
        .split(/\r?\n/)
        .map(parseSessionListLine)
        .filter(Boolean)
        .filter((session) => !needle || session.id.toLowerCase().includes(needle) || session.title.toLowerCase().includes(needle));
    } catch {
      continue;
    }
  }
  return [];
}

function opencodeCommands() {
  const names = [process.env.OPENCODE_BINARY, process.argv[0], process.execPath, process.platform === "win32" ? "opencode.cmd" : "opencode"];
  return [...new Set(names.filter((name) => name && /opencode/i.test(name)))];
}

function parseSessionListLine(line) {
  const match = /^(ses_[A-Za-z0-9]+)\s+(.+?)\s{2,}(.+)$/.exec(line.trimEnd());
  if (!match) return undefined;
  return {
    id: match[1],
    title: match[2].trim() || "Untitled",
    directory: "",
    slug: "",
    time: { created: 0, updated: 0 },
  };
}

async function sessionRow(api, session, pinned) {
  return {
    id: session.id,
    title: session.title || "Untitled",
    directory: session.directory || "",
    slug: session.slug || "",
    created: session.time?.created || 0,
    updated: session.time?.updated || 0,
    archived: session.time?.archived,
    projectID: session.projectID || session.project_id || "",
    parentID: session.parentID || session.parent_id || "",
    model: normalizeModel(session.model),
    agent: session.agent || "",
    cost: session.cost || 0,
    tokensInput: session.tokens?.input || session.tokensInput || 0,
    tokensOutput: session.tokens?.output || session.tokensOutput || 0,
    summary: session.summary || { files: 0, additions: 0, deletions: 0 },
    pinned: pinned.includes(session.id),
    preview: await sessionPreview(api, session.id),
  };
}

async function getSession(api, sessionID) {
  const sessionResult = await api.client.session.get({ sessionID });
  if (sessionResult.error) return undefined;
  const messagesResult = await assertOk(api.client.session.messages({ sessionID, limit: 200 }));
  let todos = [];
  try {
    const todoResult = await assertOk(api.client.session.todo({ sessionID }));
    todos = Array.isArray(todoResult) ? todoResult : [];
  } catch {}
  const pinned = getPinned(api);
  const output = await sessionRow(api, sessionResult.data, pinned);
  const workspace = sessionResult.data.directory || process.cwd();
  output.todos = todos;
  output.messages = await Promise.all((Array.isArray(messagesResult) ? messagesResult : []).map(async (item) => {
    const partText = (item.parts || [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n\n")
      .trim();
    const error = messageError(item.info?.error);
    const aborted = /(?:MessageAbortedError|AbortError|\bAborted\b)/i.test(error);
    const text = partText || (aborted ? "" : error);
    const activities = (item.parts || [])
      .filter((part) => part.type && part.type !== "text")
      .map((part) => {
        const activity = activityRow(part, workspace);
        return {
          ...activity,
          paths: activity.paths || resolveLocalPaths(activity.detail, workspace),
        };
      });
    const extras = activities.map((activity) => activity.label).slice(0, 8);
    if (error && partText && !aborted) extras.push(error);
    return {
      id: item.info?.id || "",
      role: item.info?.role || "message",
      created: item.info?.time?.created || 0,
      completed: item.info?.time?.completed || 0,
      error: aborted ? "" : (error || ""),
      aborted,
      text,
      paths: resolveLocalPaths(partText, workspace),
      extras,
      activities,
    };
  }));
  return output;
}

function activityRow(part, workspace) {
  if (part.type === "reasoning") {
    return {
      type: part.type,
      label: part.time?.end ? "Reasoning" : "Reasoning...",
      status: part.time?.end ? "completed" : "running",
      detail: clipActivity(part.text),
    };
  }
  if (part.type === "tool") {
    const state = part.state || {};
    const input = formatActivityValue(state.input);
    const output = state.status === "error" ? state.error : state.output;
    const outputText = output ? clipActivity(output) : "";
    const paths = state.status === "error" || /\b(?:access denied|not found|outside allowed)\b/i.test(outputText)
      ? []
      : resolveLocalPaths(outputText, workspace);
    return {
      type: part.type,
      label: state.title || part.tool || "Tool",
      status: state.status || "pending",
      detail: [input && `Input\n${input}`, outputText && `Output\n${outputText}`].filter(Boolean).join("\n\n"),
      paths,
    };
  }
  if (part.type === "subtask") {
    return {
      type: part.type,
      label: part.description || `Subtask: ${part.agent || "agent"}`,
      status: "running",
      detail: clipActivity(part.prompt),
    };
  }
  if (part.type === "step-start") return { type: part.type, label: "Step started", status: "running", detail: "" };
  if (part.type === "step-finish") {
    const tokens = part.tokens || {};
    return {
      type: part.type,
      label: `Step finished: ${part.reason || "complete"}`,
      status: "completed",
      detail: `Tokens: ${tokens.input || 0} in / ${tokens.output || 0} out${tokens.reasoning ? ` / ${tokens.reasoning} reasoning` : ""}`,
    };
  }
  if (part.type === "patch") {
    return {
      type: part.type,
      label: `Changed ${part.files?.length || 0} file(s)`,
      status: "completed",
      detail: "",
      paths: resolveLocalPaths((part.files || []).join("\n"), workspace),
    };
  }
  if (part.type === "file") {
    const path = part.source?.path || part.path || "";
    return {
      type: part.type,
      label: part.filename || path || "File",
      status: "completed",
      detail: part.mime || "",
      paths: resolveLocalPaths(path, workspace),
    };
  }
  if (part.type === "retry") {
    return { type: part.type, label: `Retry ${part.attempt || 1}`, status: "error", detail: messageError(part.error) };
  }
  if (part.type === "compaction") {
    return { type: part.type, label: part.auto ? "Automatic context compaction" : "Context compaction", status: "completed", detail: part.overflow ? "Triggered by context overflow" : "" };
  }
  if (part.type === "agent") return { type: part.type, label: `Agent: ${part.name}`, status: "completed", detail: "" };
  return { type: part.type, label: part.type, status: "completed", detail: "" };
}

function formatActivityValue(value) {
  if (!value || (typeof value === "object" && !Object.keys(value).length)) return "";
  try {
    return clipActivity(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  } catch {
    return clipActivity(String(value));
  }
}

function clipActivity(value, limit = 2400) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit)}\n...` : text;
}

function messageError(error) {
  if (!error) return "";
  const name = error.name || "OpenCode error";
  const message = error.data?.message || error.message || "";
  return message ? `${name}: ${message}` : name;
}

function resolveLocalPaths(text, workspace) {
  const value = String(text || "");
  const candidates = [];
  const seenLabels = new Set();
  const addCandidate = (label) => {
    const cleaned = cleanPathLabel(label);
    if (!cleaned || seenLabels.has(cleaned.toLowerCase())) return;
    seenLabels.add(cleaned.toLowerCase());
    candidates.push(cleaned);
  };

  for (const match of value.matchAll(/`([^`\r\n]+)`|["']([^"'\r\n]+)["']/g)) {
    addCandidate(match[1] || match[2]);
  }
  for (const line of value.split(/\r?\n/)) {
    for (const match of line.matchAll(/[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]/g)) {
      addCandidate(longestExistingPath(line.slice(match.index), workspace));
    }
  }
  for (const match of value.matchAll(/(?:^|[\s([{"'`|])((?:\.{1,2}[\\/])?(?:[^\s<>"'`|:]+[\\/])+[^\s<>"'`|:]+|(?:\.{1,2}[\\/])?[^\s<>"'`|:]+\.[A-Za-z0-9_-]{1,16})(?=$|[\s)\]},;:'"`|])/gmu)) {
    addCandidate(match[1]);
  }

  const output = [];
  const seenPaths = new Set();
  for (const label of candidates) {
    const target = isAbsolute(label) ? normalize(label) : resolve(workspace, label);
    let details;
    try {
      if (!existsSync(target)) continue;
      details = statSync(target);
    } catch {
      continue;
    }
    const key = `${label.toLowerCase()}\0${target.toLowerCase()}`;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    output.push({
      label,
      path: target,
      type: details.isDirectory() ? "directory" : "file",
    });
    if (output.length >= 40) break;
  }
  return output;
}

function longestExistingPath(raw, workspace) {
  let candidate = cleanPathLabel(
    String(raw || "")
      .split(/[<>"`|]/, 1)[0]
      .split(/\s+(?:not in|is not|does not|was not|outside|from|to)\s+/i, 1)[0]
  );
  for (let attempt = 0; candidate && attempt < 20; attempt += 1) {
    const target = isAbsolute(candidate) ? normalize(candidate) : resolve(workspace, candidate);
    if (existsSync(target)) return candidate;
    const cut = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\t"));
    if (cut < 0) break;
    candidate = cleanPathLabel(candidate.slice(0, cut));
  }
  return "";
}

function cleanPathLabel(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "")
    .replace(/^[([{<\u3008\u300a]+|[)\]}>.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f]+$/g, "");
}

function normalizeLocalPath(value) {
  const text = String(value || "")
    .trim()
    .replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "");
  return text ? normalize(text) : "";
}

async function localPathInfo(target) {
  try {
    const details = await stat(target);
    return { exists: true, type: details.isDirectory() ? "directory" : "file" };
  } catch {
    return { exists: false, type: "missing" };
  }
}

async function openLocalPath(target, type) {
  if (process.platform === "win32") {
    if (type === "directory") {
      await spawnDetached("explorer.exe", [target]);
    } else {
      await spawnDetached("rundll32.exe", ["url.dll,FileProtocolHandler", target]);
    }
    return;
  }
  await spawnDetached(process.platform === "darwin" ? "open" : "xdg-open", [target]);
}

async function revealLocalFile(target) {
  if (process.platform === "win32") {
    await spawnDetached("explorer.exe", [`/select,${target}`]);
    return;
  }
  if (process.platform === "darwin") {
    await spawnDetached("open", ["-R", target]);
    return;
  }
  await spawnDetached("xdg-open", [dirname(target)]);
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function sessionPreview(api, sessionID) {
  try {
    const messages = await assertOk(api.client.session.messages({ sessionID, limit: 4 }));
    const part = (messages || [])
      .flatMap((item) => item.parts || [])
      .find((candidate) => candidate.type === "text" && candidate.text);
    return part ? [{ role: "message", text: compact(part.text) }] : [];
  } catch {
    return [];
  }
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
  response.writeHead(200, { "content-type": mimeType(target), "cache-control": "no-store" });
  response.end(content);
}

function matchSessionAction(pathname) {
  const parts = pathname.split("/").map(decodeURIComponent);
  return [parts[2], parts[3], parts[4]];
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

function normalizeModel(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return [model.providerID || model.providerId, model.modelID || model.modelId || model.id].filter(Boolean).join("/");
}

function compact(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 220);
}

async function promptSession(api, { sessionID, text, model, files = [] }) {
  const payload = {
    sessionID,
    parts: [
      ...(text ? [{ type: "text", text }] : []),
      ...files,
    ],
  };
  const session = await getRawSession(api, sessionID);
  const listedSession = (!session?.model || !session?.agent)
    ? await getSession(api, sessionID)
    : undefined;
  const selectedModel =
    await resolvePromptModel(api, model || session?.model || listedSession?.model) ||
    await defaultPromptModel(api);
  if (selectedModel) payload.model = selectedModel;
  const agent = session?.agent || listedSession?.agent;
  if (agent) payload.agent = agent;
  const method = api.client.session.promptAsync || api.client.session.prompt;
  try {
    await assertOk(method.call(api.client.session, payload));
  } catch (error) {
    await writeLog("error", "prompt.failed", {
      sessionID,
      model: selectedModel,
      agent,
      method: method === api.client.session.promptAsync ? "promptAsync" : "prompt",
      error,
    });
    throw error;
  }
  return { method: "session", model: selectedModel };
}

function normalizePromptFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.slice(0, 8).map((file) => {
    const mime = String(file?.mime || "");
    const url = String(file?.url || "");
    if (!mime.startsWith("image/") || !url.startsWith("data:image/")) return undefined;
    return {
      type: "file",
      mime,
      filename: String(file.filename || "image"),
      url,
    };
  }).filter(Boolean);
}

async function listModels(api) {
  const providers = [];
  let defaults = {};
  if (api.opencodeUrl) {
    try {
      const result = await fetchOpenCode(api, "/config/providers");
      if (Array.isArray(result?.providers)) providers.push(...result.providers);
      if (result?.default && typeof result.default === "object") defaults = result.default;
    } catch {}
  }
  try {
    if (!providers.length) {
      const result = await assertOk(api.client.config.providers({}));
      if (Array.isArray(result?.providers)) providers.push(...result.providers);
      if (result?.default && typeof result.default === "object") defaults = result.default;
    }
  } catch {
    try {
      const result = await assertOk(api.client.provider.list({}));
      if (Array.isArray(result?.all)) providers.push(...result.all);
      if (result?.default && typeof result.default === "object") defaults = result.default;
    } catch {
      return [];
    }
  }

  const rows = [];
  for (const provider of providers) {
    const providerID = provider?.id;
    if (!providerID || !provider.models || typeof provider.models !== "object") continue;
    for (const [modelID, model] of Object.entries(provider.models)) {
      rows.push({
        providerID,
        modelID,
        label: `${provider.name || providerID} / ${model?.name || modelID}`,
        default: defaults[providerID] === modelID,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.default && !b.default) return -1;
    if (!a.default && b.default) return 1;
    return a.label.localeCompare(b.label);
  });
  return rows;
}

async function listPermissions(api) {
  try {
    const result = await assertOk(api.client.permission.list({}));
    return (Array.isArray(result) ? result : []).map(permissionRow);
  } catch {
    return [];
  }
}

async function listQuestions(api) {
  try {
    const result = await assertOk(api.client.question.list({}));
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function permissionRow(item) {
  const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  return {
    id: item?.id || "",
    sessionID: item?.sessionID || "",
    permission: item?.permission || "permission",
    patterns: Array.isArray(item?.patterns) ? item.patterns.map(String) : [],
    always: Array.isArray(item?.always) ? item.always.map(String) : [],
    tool: item?.tool || undefined,
    metadata,
    summary: permissionSummary(item?.permission, item?.patterns, metadata),
  };
}

function permissionSummary(permission, patterns, metadata) {
  const details = [];
  if (Array.isArray(patterns) && patterns.length) details.push(patterns.join(", "));
  for (const [key, value] of Object.entries(metadata || {})) {
    if (["command", "path", "file", "url", "description"].includes(key.toLowerCase())) details.push(`${key}: ${String(value)}`);
  }
  return details.length ? details.join(" | ") : String(permission || "Permission requested");
}

async function resolvePromptModel(api, model) {
  const normalized = normalizeModelObject(model);
  if (!normalized) return undefined;

  const models = await listModels(api);
  const exact = models.find((item) =>
    item.providerID === normalized.providerID && item.modelID === normalized.modelID
  );
  if (exact) return { providerID: exact.providerID, modelID: exact.modelID };

  const shorthand = [
    normalized.modelID,
    normalized.providerID,
    normalizeModel(model),
  ].filter(Boolean);
  const match = models.find((item) =>
    shorthand.includes(item.modelID) ||
    shorthand.includes(`${item.providerID}/${item.modelID}`)
  );
  return match
    ? { providerID: match.providerID, modelID: match.modelID }
    : normalized;
}

async function defaultPromptModel(api) {
  const models = await listModels(api);
  const selected =
    models.find((item) => item.default && item.providerID === "opencode") ||
    models.find((item) => item.default) ||
    models[0];
  return selected
    ? { providerID: selected.providerID, modelID: selected.modelID }
    : undefined;
}

async function getRawSession(api, sessionID) {
  if (api.opencodeUrl) {
    try {
      return await fetchOpenCode(api, `/session/${encodeURIComponent(sessionID)}`);
    } catch {}
  }
  try {
    return await assertOk(api.client.session.get({ sessionID }));
  } catch {
    return undefined;
  }
}

async function fetchOpenCode(api, pathname) {
  const response = await fetch(new URL(pathname, api.opencodeUrl), {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`OpenCode API returned ${response.status}`);
  return response.json();
}

function normalizeModelObject(model) {
  if (!model) return undefined;
  if (typeof model === "string") return splitModelID(model);
  const providerID = model.providerID || model.providerId || model.provider;
  const modelID = model.modelID || model.modelId || model.id || model.model;
  if (providerID && modelID) return { providerID, modelID };
  if (providerID && !modelID) return splitModelID(providerID);
  if (!providerID && modelID) return splitModelID(modelID);
  return undefined;
}

function splitModelID(value) {
  const text = String(value || "").trim();
  if (!text) return undefined;
  const slash = text.indexOf("/");
  if (slash > 0) return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) };
  return { providerID: "opencode", modelID: text };
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return JSON.stringify(error);
}

function isAuthorized(request, url) {
  if (!serverToken) return false;
  const header = request.headers["x-history-browser-token"];
  return header === serverToken || url.searchParams.get("token") === serverToken;
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

async function ensureBrowserLauncher() {
  if (process.platform !== "win32") return;
  await mkdir(dirname(LAUNCHER_FILE), { recursive: true });
  const nodeExecutable = resolveNodeExecutable();
  const script = [
    'Set shell = CreateObject("WScript.Shell")',
    'shell.Environment("Process")("OPENCODE_BROWSER_MODE") = "1"',
    `shell.Run Chr(34) & "${nodeExecutable.replaceAll('"', '""')}" & Chr(34) & " " & Chr(34) & "${join(root, "standalone.js").replaceAll('"', '""')}" & Chr(34), 0, False`,
    "",
  ].join("\r\n");
  const candidates = [
    join(homedir(), "Desktop"),
    process.env.OneDrive ? join(process.env.OneDrive, "Desktop") : "",
  ].filter((desktop, index, values) => desktop && existsSync(desktop) && values.indexOf(desktop) === index);
  await writeFile(LAUNCHER_FILE, script, "utf8");
  await Promise.all(candidates.map((desktop) => writeFile(join(desktop, LAUNCHER_NAME), script, "utf8")));
  await writeLog("info", "launcher.installed", { launcher: LAUNCHER_FILE, nodeExecutable });
}

function resolveNodeExecutable() {
  if (process.platform !== "win32") return process.execPath;
  const candidates = [
    process.env.NODE,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "nodejs", "node.exe") : "",
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe") : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "node.exe";
}

async function ensureCommandRedirect() {
  if (process.platform !== "win32") return;
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const npmDir = join(appData, "npm");
  const launcher = LAUNCHER_FILE;
  const cmd = join(npmDir, "opencode.cmd");
  const cliCmd = join(npmDir, `${REDIRECT_BACKUP_BASENAME}.cmd`);
  const ps1 = join(npmDir, "opencode.ps1");
  const cliPs1 = join(npmDir, `${REDIRECT_BACKUP_BASENAME}.ps1`);
  const currentCmd = existsSync(cmd) ? await readFile(cmd, "utf8") : "";
  const currentPs1 = existsSync(ps1) ? await readFile(ps1, "utf8") : "";
  if ([currentCmd, currentPs1].some((current) => hasForeignHistoryRedirect(current, REDIRECT_MARKER))) {
    throw new Error("The legacy History Browser redirect is active. Uninstall it before installing the next edition.");
  }
  const directCommand = await resolveOpenCodeCommand();
  if (currentCmd) {
    if (!ownsRedirect(currentCmd, REDIRECT_MARKER)) {
      await writeFile(cliCmd, currentCmd, "utf8");
    } else if (!existsSync(cliCmd)) {
      await writeFile(cliCmd, buildBackupForwarder(".cmd", directCommand), "utf8");
    }
    await writeFile(cmd, [
      "@ECHO off",
      `REM ${REDIRECT_MARKER}`,
      'IF NOT "%~1"=="" GOTO cli',
      `START "" /B wscript.exe "${launcher}"`,
      "EXIT /B 0",
      ":cli",
      `CALL "${cliCmd}" %*`,
      "",
    ].join("\r\n"), "utf8");
  }
  if (currentPs1) {
    if (!ownsRedirect(currentPs1, REDIRECT_MARKER)) {
      await writeFile(cliPs1, currentPs1, "utf8");
    } else if (!existsSync(cliPs1)) {
      await writeFile(cliPs1, buildBackupForwarder(".ps1", directCommand), "utf8");
    }
    await writeFile(ps1, [
      `# ${REDIRECT_MARKER}`,
      `if ($args.Count -eq 0 -and -not $MyInvocation.ExpectingInput) { Start-Process -FilePath "wscript.exe" -ArgumentList '"${launcher}"' -WindowStyle Hidden; exit 0 }`,
      `& "${cliPs1}" @args`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n"), "utf8");
  }
  await writeLog("info", "redirect.installed", { npmDir });
}

async function restoreCommandRedirect() {
  if (process.platform !== "win32") return false;
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const npmDir = join(appData, "npm");
  let restored = false;
  for (const extension of [".cmd", ".ps1"]) {
    const command = join(npmDir, `opencode${extension}`);
    const original = join(npmDir, `${REDIRECT_BACKUP_BASENAME}${extension}`);
    if (!existsSync(original) || !existsSync(command)) continue;
    const current = await readFile(command, "utf8");
    if (!ownsRedirect(current, REDIRECT_MARKER)) continue;
    await writeFile(command, await readFile(original, "utf8"), "utf8");
    await unlink(original).catch(() => {});
    restored = true;
  }
  return restored;
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

async function firstAvailableCommand(candidates) {
  for (const candidate of [...new Set(candidates)]) {
    if (await commandExists(candidate)) return candidate;
  }
  return "";
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

async function uninstallSelf(api) {
  const { removed, redirectRestored } = await uninstallPlugin();

  if (!removed.length && !redirectRestored) {
    api.ui.toast({
      variant: "warning",
      title: "History Browser",
      message: "Plugin entry was not found. OpenCode itself was not changed.",
      duration: 6000,
    });
    return;
  }

  api.ui.toast({
    variant: "success",
    title: "History Browser uninstalled",
    message: "Restart OpenCode to finish removing it. The original opencode command stays available.",
    duration: 8000,
  });
}

async function uninstallPlugin() {
  const redirectRestored = await restoreCommandRedirect();
  const removed = [];
  for (const file of tuiConfigCandidates()) {
    if (await removePluginFromConfig(file)) removed.push(file);
  }
  for (const launcher of browserLauncherCandidates()) {
    if (!existsSync(launcher)) continue;
    await unlink(launcher);
    removed.push(launcher);
  }
  return {
    removed,
    redirectRestored,
    message: removed.length || redirectRestored
      ? "Plugin removed. Restart OpenCode and the original opencode command will keep working."
      : "Plugin entry was not found. OpenCode itself was not modified.",
  };
}

function browserLauncherCandidates() {
  return [...new Set([
    LAUNCHER_FILE,
    join(homedir(), "Desktop", LAUNCHER_NAME),
    process.env.OneDrive ? join(process.env.OneDrive, "Desktop", LAUNCHER_NAME) : "",
  ].filter(Boolean))];
}

function tuiConfigCandidates() {
  const home = homedir();
  const paths = [];
  if (process.env.XDG_CONFIG_HOME) paths.push(join(process.env.XDG_CONFIG_HOME, "opencode", "tui.json"));
  if (home) paths.push(join(home, ".config", "opencode", "tui.json"));
  if (process.env.APPDATA) paths.push(join(process.env.APPDATA, "opencode", "tui.json"));
  return [...new Set(paths)];
}

async function removePluginFromConfig(file) {
  if (!existsSync(file)) return false;
  const text = await readFile(file, "utf8");
  const config = JSON.parse(text || "{}");
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const next = plugins.filter((plugin) => !isThisPlugin(plugin));
  if (next.length === plugins.length) return false;
  config.plugin = next;
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return true;
}

function isThisPlugin(plugin) {
  return typeof plugin === "string" && (
    plugin === id ||
    plugin.startsWith(`${id}@`) ||
    plugin === REPOSITORY_SPEC ||
    plugin.startsWith(`${REPOSITORY_SPEC}#`)
  );
}

async function startBrowserHost(api) {
  registerShutdownHandlers();
  const url = await ensureServer(api);
  if (process.env.OPENCODE_HISTORY_BROWSER_NO_OPEN !== "1") openUrl(url);
  return { url, close: closeServer };
}

export {
  buildBalancedSnapshot,
  ensureBrowserLauncher,
  ensureCommandRedirect,
  inferPluginName,
  inferSkillScope,
  normalizeMcpServer,
  startBrowserHost,
};
export default { id, tui };
