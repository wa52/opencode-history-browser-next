import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";

const id = "opencode-history-browser";
const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const execFileAsync = promisify(execFile);
let server;
let serverUrl;

async function tui(api) {
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
      onSelect: start,
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
  ]);

  setTimeout(start, 1000);
}

async function ensureServer(api) {
  if (server?.listening && serverUrl) return serverUrl;

  server = createServer((request, response) => {
    handleRequest(api, request, response).catch((error) => {
      sendJson(response, { error: errorMessage(error) }, 500);
    });
  });

  const port = await listenOnAvailablePort(server, 8765);
  serverUrl = `http://127.0.0.1:${port}/`;
  return serverUrl;
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
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const query = url.searchParams.get("q") || "";
    const sessions = await listSessions(api, query);
    return sendJson(response, { sessions });
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const sessionID = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
    const session = await getSession(api, sessionID);
    if (!session) return sendJson(response, { error: "Session not found" }, 404);
    return sendJson(response, { session });
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
    if (action === "open") {
      await assertOk(api.client.tui.selectSession({ sessionID }));
      return sendJson(response, { ok: true, command: `opencode --session ${sessionID}` });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/open-new") {
    const result = await assertOk(api.client.session.create({ title: "New chat" }));
    const sessionID = result?.id;
    if (sessionID) await assertOk(api.client.tui.selectSession({ sessionID }));
    return sendJson(response, { ok: true, command: "opencode" });
  }

  return serveStatic(response, url.pathname);
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
  const pinned = getPinned(api);
  const output = await sessionRow(api, sessionResult.data, pinned);
  output.messages = (Array.isArray(messagesResult) ? messagesResult : []).map((item) => {
    const text = (item.parts || [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n\n")
      .trim();
    const extras = (item.parts || []).filter((part) => part.type && part.type !== "text").map((part) => part.type).slice(0, 8);
    return {
      id: item.info?.id || "",
      role: item.info?.role || "message",
      created: item.info?.time?.created || 0,
      text,
      extras,
    };
  });
  return output;
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

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return JSON.stringify(error);
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

async function uninstallSelf(api) {
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

export default { id, tui };
