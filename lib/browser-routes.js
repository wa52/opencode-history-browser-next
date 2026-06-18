import { buildBalancedSnapshot } from "./browser-snapshot.js";
import {
  createSession,
  getSession,
  listModels,
  listPermissions,
  listQuestions,
  listSessions,
  normalizePromptFiles,
  promptSession,
} from "./opencode-session.js";
import {
  localPathInfo,
  normalizeLocalPath,
  openLocalPath,
  revealLocalFile,
} from "./local-paths.js";

function createRequestHandler({
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
  getPinned,
  setPinned,
  removePinned,
  openTuiPanel,
  openOpenCodeTerminal,
  uninstallPlugin,
  normalizeModelObject,
  mapSkill,
  normalizeMcpServer,
}) {
  return async function handleRequest(request, response) {
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
      return sendJson(response, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const query = url.searchParams.get("q") || "";
      const sessions = await listSessions(api, query, getPinned());
      return sendJson(response, { sessions });
    }

    if (request.method === "GET" && url.pathname === "/api/models") {
      return sendJson(response, { models: await listModels(api) });
    }

    if (request.method === "GET" && url.pathname === "/api/permissions") {
      return sendJson(response, { permissions: await listPermissions(api) });
    }

    if (request.method === "GET" && url.pathname === "/api/questions") {
      return sendJson(response, { questions: await listQuestions(api) });
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
        skills: (Array.isArray(skills) ? skills : []).map(mapSkill),
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
      if (!target || !/^(?:[A-Za-z]:|\\\\)/.test(target)) return sendJson(response, { error: "A valid absolute local path is required." }, 400);
      const info = await localPathInfo(target);
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
      const session = await getSession(api, sessionID, getPinned());
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
          removePinned(sessionID);
          results.push({ id: sessionID, ok: true });
        } catch (error) {
          results.push({ id: sessionID, ok: false, error: errorMessage(error) });
        }
      }
      return sendJson(response, { ok: results.every((item) => item.ok), results });
    }

    if (request.method === "POST" && url.pathname.startsWith("/api/tui/")) {
      const action = url.pathname.slice("/api/tui/".length);
      await openTuiPanel(action);
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
        setPinned(sessionID, Boolean(body.pinned));
        return sendJson(response, { ok: true });
      }
      if (action === "delete") {
        await assertOk(api.client.session.delete({ sessionID }));
        removePinned(sessionID);
        return sendJson(response, { ok: true });
      }
      if (action === "snapshot") {
        const session = await getSession(api, sessionID, getPinned());
        if (!session) return sendJson(response, { error: "Session not found" }, 404);
        const snapshot = buildBalancedSnapshot(session);
        const created = await createSession(api, {
          title: `Snapshot - ${session.title || "Untitled"}`,
          directory: session.workspaceRoot || session.directory || "",
          metadata: {
            snapshotSourceSessionID: session.id,
            snapshotSourceUpdated: session.updated || 0,
            snapshotMode: "balanced",
          },
        });
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
      const body = await readJson(request);
      const directory = String(body.directory || "").trim();
      const result = await createSession(api, {
        title: "New chat",
        directory,
        metadata: directory ? { createdFrom: "browser-new-chat" } : undefined,
      });
      const sessionID = result?.id;
      if (sessionID && !api.headless) await assertOk(api.client.tui.selectSession({ sessionID }));
      return sendJson(response, { ok: true, command: "opencode", sessionID, directory });
    }

    return serveStatic(response, url.pathname);
  };
}

function matchSessionAction(pathname) {
  const parts = pathname.split("/").map(decodeURIComponent);
  return [parts[2], parts[3], parts[4]];
}

export { createRequestHandler };
