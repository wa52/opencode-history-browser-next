import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeLog } from "../log.js";
import { resolveLocalPaths } from "./local-paths.js";

const execFileAsync = promisify(execFile);

async function listSessions(api, search, pinned = []) {
  const client = api.client.experimental?.session || api.client.session;
  const result = await unwrap(client.list({ limit: 250, search: search || undefined, archived: false }));
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

async function getSession(api, sessionID, pinned = []) {
  const sessionResult = await api.client.session.get({ sessionID });
  if (sessionResult.error || !sessionResult.data) return undefined;
  const messagesResult = await unwrap(api.client.session.messages({ sessionID, limit: 200 }));
  let todos = [];
  try {
    const todoResult = await unwrap(api.client.session.todo({ sessionID }));
    todos = Array.isArray(todoResult) ? todoResult : [];
  } catch {}
  const output = await sessionRow(api, sessionResult.data, pinned);
  const workspace = sessionWorkspaceRoot(sessionResult.data) || process.cwd();
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

async function promptSession(api, { sessionID, text, model, files = [] }) {
  const payload = {
    sessionID,
    parts: [
      ...(text ? [{ type: "text", text }] : []),
      ...files,
    ],
  };
  const session = await getRawSession(api, sessionID);
  const listedSession = (!session?.model || !session?.agent || !sessionWorkspaceRoot(session))
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
    await unwrap(method.call(api.client.session, payload));
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

async function createSession(api, {
  title,
  parentID,
  agent,
  model,
  metadata,
  directory,
  workspaceID,
} = {}) {
  const workspaceRoot = normalizeWorkspaceRoot(directory);
  const sessionMetadata = {
    ...(metadata && typeof metadata === "object" ? metadata : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
  };
  const payload = {
    ...(title ? { title } : {}),
    ...(parentID ? { parentID } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(Object.keys(sessionMetadata).length ? { metadata: sessionMetadata } : {}),
    ...(workspaceID ? { workspaceID } : {}),
    ...(workspaceRoot ? { directory: workspaceRoot } : {}),
  };
  return unwrap(api.client.session.create(payload));
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
      const result = await unwrap(api.client.config.providers({}));
      if (Array.isArray(result?.providers)) providers.push(...result.providers);
      if (result?.default && typeof result.default === "object") defaults = result.default;
    }
  } catch {
    try {
      const result = await unwrap(api.client.provider.list({}));
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
    const result = await unwrap(api.client.permission.list({}));
    return (Array.isArray(result) ? result : []).map(permissionRow);
  } catch {
    return [];
  }
}

async function listQuestions(api) {
  try {
    const result = await unwrap(api.client.question.list({}));
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function normalizeModel(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return [model.providerID || model.providerId, model.modelID || model.modelId || model.id].filter(Boolean).join("/");
}

function errorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return JSON.stringify(error);
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
  const workspaceRoot = sessionWorkspaceRoot(session);
  return {
    id: session.id,
    title: session.title || "Untitled",
    directory: session.directory || "",
    workspaceRoot,
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

async function sessionPreview(api, sessionID) {
  try {
    const messages = await unwrap(api.client.session.messages({ sessionID, limit: 4 }));
    const part = (messages || [])
      .flatMap((item) => item.parts || [])
      .find((candidate) => candidate.type === "text" && candidate.text);
    return part ? [{ role: "message", text: compact(part.text) }] : [];
  } catch {
    return [];
  }
}

function compact(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 220);
}

function sessionWorkspaceRoot(session) {
  if (!session || typeof session !== "object") return "";
  const metadata = session.metadata && typeof session.metadata === "object" ? session.metadata : {};
  const candidate = metadata.workspaceRoot || metadata.workspace_root || session.directory || "";
  return normalizeWorkspaceRoot(candidate);
}

function normalizeWorkspaceRoot(value) {
  const text = String(value || "").trim();
  return text || "";
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
    return await unwrap(api.client.session.get({ sessionID }));
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

async function unwrap(promise) {
  const result = await promise;
  if (result?.error) throw new Error(errorMessage(result.error));
  return result?.data;
}

export {
  createSession,
  errorMessage,
  getSession,
  listModels,
  listPermissions,
  listQuestions,
  listSessions,
  normalizeModel,
  normalizeModelObject,
  normalizePromptFiles,
  promptSession,
  sessionWorkspaceRoot,
};
