import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const id = "opencode-history-browser";
const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const execFileAsync = promisify(execFile);
const browserMode = process.env.OPENCODE_BROWSER_MODE === "1";
const cliMode = process.env.OPENCODE_HISTORY_CLI === "1";
let server;
let serverUrl;
let serverToken;
let serverIdleTimer;
let lastBrowserSeen = 0;
let shutdownHandlersRegistered = false;
const serverSockets = new Set();
const serverIdleMs = 2 * 60 * 1000;

async function tui(api) {
  if (!cliMode) {
    registerShutdownHandlers();
    ensureBrowserLauncher().catch(() => {});
    ensureCommandRedirect().catch(() => {});
  }
  const start = async () => {
    serverUrl = await ensureServer(api);
    openUrl(serverUrl);
    api.ui.toast({
      variant: "success",
      title: "History Browser",
      message: `Opened ${serverUrl}`,
      duration: 3500,
    });
  };
  const safeStart = () => {
    start().catch((error) => {
      api.ui.toast({
        variant: "error",
        title: "History Browser failed",
        message: errorMessage(error),
        duration: 7000,
      });
    });
  };

  api.command.register(() => [
    {
      title: "Open History Browser",
      value: "history-browser.open",
      description: "Browse, pin, rename, delete, and continue OpenCode chats.",
      category: "History",
      slash: {
        name: "history-browser",
        aliases: ["history-ui", "chat-history"],
      },
      onSelect: safeStart,
    },
    {
      title: "Uninstall History Browser",
      value: "history-browser.uninstall",
      description: "Remove this plugin from OpenCode TUI config.",
      category: "History",
      slash: {
        name: "history-browser-uninstall",
      },
      onSelect: () => uninstallSelf(api),
    },
    {
      title: "Check History Browser Install",
      value: "history-browser.doctor",
      description: "Verify that the browser plugin can start and read OpenCode sessions.",
      category: "History",
      slash: {
        name: "history-browser-doctor",
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
      sendJson(response, { error: errorMessage(error) }, 500);
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
  startIdleMonitor();
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
  if (url.pathname.startsWith("/api/") && !isAuthorized(request, url)) {
    return sendJson(response, { error: "Unauthorized history browser request" }, 401);
  }
  if (url.pathname.startsWith("/api/")) markBrowserSeen();

  if (request.method === "POST" && url.pathname === "/api/heartbeat") {
    return sendJson(response, { ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/browser-close") {
    lastBrowserSeen = 0;
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
      skills: (Array.isArray(skills) ? skills : []).map(({ name, description, location }) => ({ name, description, location })),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/mcp") {
    const status = await assertOk(api.client.mcp.status({}));
    return sendJson(response, { servers: Object.entries(status || {}).map(([name, value]) => ({ name, ...value })) });
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
    await openOpenCodeTerminal({ directory, sessionID, serverUrl: api.opencodeUrl });
    return sendJson(response, { ok: true, sessionID, directory });
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
  let source = Array.isArray(result) ? result : [];
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
  output.todos = todos;
  output.messages = (Array.isArray(messagesResult) ? messagesResult : []).map((item) => {
    const partText = (item.parts || [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n\n")
      .trim();
    const error = messageError(item.info?.error);
    const text = partText || error;
    const activities = (item.parts || []).filter((part) => part.type && part.type !== "text").map(activityRow);
    const extras = activities.map((activity) => activity.label).slice(0, 8);
    if (error && partText) extras.push(error);
    return {
      id: item.info?.id || "",
      role: item.info?.role || "message",
      created: item.info?.time?.created || 0,
      completed: item.info?.time?.completed || 0,
      error: error || "",
      text,
      extras,
      activities,
    };
  });
  return output;
}

function activityRow(part) {
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
    return {
      type: part.type,
      label: state.title || part.tool || "Tool",
      status: state.status || "pending",
      detail: [input && `Input\n${input}`, output && `Output\n${clipActivity(output)}`].filter(Boolean).join("\n\n"),
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
    return { type: part.type, label: `Changed ${part.files?.length || 0} file(s)`, status: "completed", detail: (part.files || []).join("\n") };
  }
  if (part.type === "file") {
    return { type: part.type, label: part.filename || part.source?.path || "File", status: "completed", detail: part.mime || "" };
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
  const value = api.kv.get("history-browser:pinned", []);
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function setPinned(api, sessionID, pinned) {
  const next = getPinned(api).filter((item) => item !== sessionID);
  if (pinned) next.unshift(sessionID);
  api.kv.set("history-browser:pinned", next);
}

function removePinned(api, sessionID) {
  api.kv.set("history-browser:pinned", getPinned(api).filter((item) => item !== sessionID));
}

async function serveStatic(response, requestPath) {
  const relative = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  const target = normalize(join(publicDir, relative));
  if (!target.startsWith(normalize(publicDir)) || !existsSync(target)) {
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
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  if (!api.headless && !model && !files.length && api.client.tui?.appendPrompt && api.client.tui?.submitPrompt) {
    await assertOk(api.client.tui.selectSession({ sessionID }));
    if (api.client.tui.clearPrompt) await assertOk(api.client.tui.clearPrompt({}));
    await assertOk(api.client.tui.appendPrompt({ text }));
    await assertOk(api.client.tui.submitPrompt({}));
    return { method: "tui" };
  }

  const payload = {
    sessionID,
    parts: [
      ...(text ? [{ type: "text", text }] : []),
      ...files,
    ],
  };
  const selectedModel = model || await promptModel(api, sessionID);
  if (selectedModel) payload.model = selectedModel;
  const method = api.client.session.promptAsync || api.client.session.prompt;
  await assertOk(method.call(api.client.session, payload));
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
  try {
    const result = await assertOk(api.client.config.providers({}));
    if (Array.isArray(result?.providers)) providers.push(...result.providers);
    if (result?.default && typeof result.default === "object") defaults = result.default;
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

async function promptModel(api, sessionID) {
  const session = await getRawSession(api, sessionID);
  const normalized = normalizeModelObject(session?.model);
  if (normalized) return normalized;
  const fallback = normalizeModelObject(session?.next?.model || session?.nextModel || session?.modelID || session?.modelId);
  if (fallback) return fallback;
  const listed = await getSession(api, sessionID);
  const listedModel = normalizeModelObject(listed?.model);
  if (listedModel) return listedModel;
  return undefined;
}

async function getRawSession(api, sessionID) {
  try {
    return await assertOk(api.client.session.get({ sessionID }));
  } catch {
    return undefined;
  }
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

function buildBalancedSnapshot(session) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const facts = importantLines(messages);
  const recent = messages.slice(-10).map((message) => {
    const speaker = message.role === "user" ? "User" : "Assistant";
    return `- ${speaker}: ${clip(message.text || message.extras?.join(", ") || "", 650)}`;
  }).filter((line) => line.trim().length > 10);

  return [
    "# Context Snapshot",
    "",
    "Use this compressed context to continue the work. The original OpenCode session is preserved separately.",
    "",
    "## Source",
    `- Title: ${session.title || "Untitled"}`,
    `- Session ID: ${session.id}`,
    `- Folder: ${session.directory || "Unknown"}`,
    `- Updated: ${session.updated ? new Date(session.updated).toLocaleString() : "Unknown"}`,
    "",
    "## Goal",
    `- ${inferGoal(messages)}`,
    "",
    "## Current State",
    ...currentState(messages),
    "",
    "## Important Details",
    ...(facts.length ? facts.map((line) => `- ${line}`) : ["- No high-signal paths, commands, errors, or decisions were detected automatically."]),
    "",
    "## Recent Context",
    ...(recent.length ? recent : ["- No recent message text was available."]),
    "",
    "## Next Steps",
    "- Continue from this snapshot instead of re-reading the entire original session.",
    "- Ask for the original session if exact wording, omitted logs, or full command output is needed.",
  ].join("\n");
}

function inferGoal(messages) {
  const firstUser = messages.find((message) => message.role === "user" && message.text?.trim());
  if (!firstUser) return "Continue the previous OpenCode task using the structured context below.";
  return clip(firstUser.text, 420);
}

function currentState(messages) {
  const assistant = [...messages].reverse().find((message) => message.role !== "user" && message.text?.trim());
  const user = [...messages].reverse().find((message) => message.role === "user" && message.text?.trim());
  const lines = [];
  if (assistant) lines.push(`- Last assistant state: ${clip(assistant.text, 520)}`);
  if (user) lines.push(`- Latest user request: ${clip(user.text, 420)}`);
  return lines.length ? lines : ["- No clear current state was detected."];
}

function importantLines(messages) {
  const patterns = [
    /[A-Za-z]:\\[^\s"'<>|]+/g,
    /(?:\.\/|\.\.\/|\/)[^\s"'<>|]+/g,
    /`([^`]{3,160})`/g,
    /\b(?:error|failed|exception|timeout|denied|warning|TODO|FIXME)\b[^\n]*/gi,
    /(?:\u51b3\u5b9a|\u95ee\u9898|\u9519\u8bef|\u5931\u8d25|\u8def\u5f84|\u547d\u4ee4|\u4e0b\u4e00\u6b65|\u6ce8\u610f|\u7ea6\u675f|\u9700\u8981|\u5df2\u7ecf)[^\n\u3002]{0,120}/g,
  ];
  const seen = new Set();
  const output = [];
  for (const message of messages) {
    const text = String(message.text || "");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const value = clip((match[1] || match[0]).replace(/\s+/g, " ").trim(), 220);
        const key = value.toLowerCase();
        if (value.length < 3 || seen.has(key)) continue;
        seen.add(key);
        output.push(value);
        if (output.length >= 28) return output;
      }
    }
  }
  return output;
}

function clip(text, max) {
  const value = String(text).replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
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

function startIdleMonitor() {
  if (serverIdleTimer) clearInterval(serverIdleTimer);
  serverIdleTimer = setInterval(() => {
    if (!server?.listening || !lastBrowserSeen) return closeServerAndExitBrowserMode();
    if (Date.now() - lastBrowserSeen > serverIdleMs) closeServerAndExitBrowserMode();
  }, 15000);
  serverIdleTimer.unref?.();
}

function closeServerAndExitBrowserMode() {
  closeServer();
  if (browserMode) process.exit(0);
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
  const configDir = join(homedir(), ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  const launcher = join(configDir, "OpenCode Browser.vbs");
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
  await writeFile(launcher, script, "utf8");
  await Promise.all(candidates.map((desktop) => writeFile(join(desktop, "OpenCode Browser.vbs"), script, "utf8")));
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
  const launcher = join(homedir(), ".config", "opencode", "OpenCode Browser.vbs");
  const cmd = join(npmDir, "opencode.cmd");
  const cliCmd = join(npmDir, "opencode-cli.cmd");
  if (existsSync(cmd)) {
    const current = await readFile(cmd, "utf8");
    if (!current.includes("OPENCODE_HISTORY_BROWSER_REDIRECT")) await writeFile(cliCmd, current, "utf8");
    await writeFile(cmd, [
      "@ECHO off",
      "REM OPENCODE_HISTORY_BROWSER_REDIRECT",
      'IF NOT "%~1"=="" GOTO cli',
      `START "" /B wscript.exe "${launcher}"`,
      "EXIT /B 0",
      ":cli",
      `CALL "${cliCmd}" %*`,
      "",
    ].join("\r\n"), "utf8");
  }
  const ps1 = join(npmDir, "opencode.ps1");
  const cliPs1 = join(npmDir, "opencode-cli.ps1");
  if (existsSync(ps1)) {
    const current = await readFile(ps1, "utf8");
    if (!current.includes("OPENCODE_HISTORY_BROWSER_REDIRECT")) await writeFile(cliPs1, current, "utf8");
    await writeFile(ps1, [
      "# OPENCODE_HISTORY_BROWSER_REDIRECT",
      `if ($args.Count -eq 0 -and -not $MyInvocation.ExpectingInput) { Start-Process -FilePath "wscript.exe" -ArgumentList '"${launcher}"' -WindowStyle Hidden; exit 0 }`,
      `& "${cliPs1}" @args`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n"), "utf8");
  }
}

async function restoreCommandRedirect() {
  if (process.platform !== "win32") return;
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const npmDir = join(appData, "npm");
  for (const extension of [".cmd", ".ps1"]) {
    const command = join(npmDir, `opencode${extension}`);
    const original = join(npmDir, `opencode-cli${extension}`);
    if (existsSync(original)) await writeFile(command, await readFile(original, "utf8"), "utf8");
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

async function openOpenCodeTerminal({ directory, sessionID, serverUrl }) {
  const args = serverUrl
    ? ["attach", serverUrl, "--dir", directory, ...(sessionID ? ["--session", sessionID] : [])]
    : (sessionID ? ["--session", sessionID] : []);
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    const executable = join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    const cliCommand = join(appData, "npm", "opencode-cli.cmd");
    const command = existsSync(executable) ? executable : cliCommand;
    const cwd = existsSync(directory) ? directory : homedir();
    const env = { ...process.env, OPENCODE_HISTORY_CLI: "1" };
    try {
      await spawnVisible("wt.exe", ["-w", "new", "-d", cwd, command, ...args], { cwd, env });
      return;
    } catch {
      const argumentList = args.length ? ` -ArgumentList @(${args.map(quotePowerShell).join(", ")})` : "";
      const script = `Start-Process -FilePath ${quotePowerShell(command)}${argumentList} -WorkingDirectory ${quotePowerShell(cwd)}`;
      await spawnVisible("powershell.exe", ["-NoProfile", "-Command", script], { cwd, env });
    }
    return;
  }
  const terminal = process.platform === "darwin" ? "open" : "x-terminal-emulator";
  const terminalArgs = process.platform === "darwin"
    ? ["-a", "Terminal", directory]
    : ["-e", "opencode", ...args];
  await spawnVisible(terminal, terminalArgs, {
    cwd: existsSync(directory) ? directory : homedir(),
    env: { ...process.env, OPENCODE_HISTORY_CLI: "1" },
  });
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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
      child.unref();
      resolve();
    });
  });
}

async function uninstallSelf(api) {
  await restoreCommandRedirect().catch(() => {});
  const files = tuiConfigCandidates();
  const removed = [];
  for (const file of files) {
    const changed = await removePluginFromConfig(file);
    if (changed) removed.push(file);
  }

  if (!removed.length) {
    api.ui.toast({
      variant: "warning",
      title: "History Browser",
      message: "Plugin entry was not found. Check your OpenCode tui.json.",
      duration: 6000,
    });
    return;
  }

  api.ui.toast({
    variant: "success",
    title: "History Browser uninstalled",
    message: "Restart OpenCode to finish removing it.",
    duration: 8000,
  });
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
    plugin === "github:wa52/opencode-history-browser" ||
    plugin.startsWith("github:wa52/opencode-history-browser#")
  );
}

async function startBrowserHost(api) {
  registerShutdownHandlers();
  const url = await ensureServer(api);
  openUrl(url);
  return { url, close: closeServer };
}

export { ensureBrowserLauncher, ensureCommandRedirect, startBrowserHost };
export default { id, tui };
