const $ = (id) => document.getElementById(id);

let sessions = [];
let current = null;
let renameMode = false;
let selectMode = false;
let sending = false;
let promptWatcher = null;
let activePromptSessionID = null;
let liveRefreshTimer = null;
let liveRefreshInFlight = false;
let liveRefreshTicks = 0;
let modelOptions = [];
let selectedModel = readStoredJson("historyBrowser:model", null);
let selectedTheme = localStorage.getItem("historyBrowser:theme") || "system";
let attachments = [];
let permissions = [];
let questions = [];
const selectedIds = new Set();
const browserCommands = [
  { command: "/skills", label: "View installed skills" },
  { command: "/mcp", label: "View MCP status" },
];
const apiToken = new URLSearchParams(window.location.search).get("token") || "";
const promptPollMs = 1500;
const promptMaxWaitMs = 10 * 60 * 1000;
const promptStableFallbackTicks = Math.ceil((3 * 60 * 1000) / promptPollMs);

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : "Unknown time");

const shortPath = (path) => {
  if (!path) return "Unknown folder";
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
};

const request = async (url, options) => {
  const target = apiToken && url.startsWith("/api/") ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(apiToken)}` : url;
  const res = await fetch(target, {
    headers: {
      "Content-Type": "application/json",
      ...(apiToken ? { "X-History-Browser-Token": apiToken } : {}),
    },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
};

async function loadSessions() {
  const q = $("search").value.trim();
  const data = await request(`/api/sessions?q=${encodeURIComponent(q)}`);
  sessions = data.sessions;
  renderSessions();
}

function renderSessions() {
  $("sessionList").innerHTML = "";
  for (const session of sessions) {
    const item = document.createElement("button");
    item.className = `session-item ${current?.id === session.id ? "active" : ""} ${selectMode ? "selecting" : ""}`;
    item.onclick = () => {
      if (selectMode) toggleSelected(session.id);
      else selectSession(session.id);
    };
    const preview = session.preview?.[0]?.text || session.directory || "";
    const checkbox = selectMode ? `<input class="session-check" type="checkbox" ${selectedIds.has(session.id) ? "checked" : ""} aria-label="Select chat" />` : "";
    item.innerHTML = `
      ${checkbox}
      <div>
        <div class="session-title">${session.pinned ? "<span class=\"pin\">Pinned</span>" : ""}<span>${escapeHtml(session.title || "Untitled")}</span></div>
        <div class="session-preview">${escapeHtml(preview)}</div>
        <div class="session-time">${fmtTime(session.updated)}</div>
      </div>
    `;
    $("sessionList").appendChild(item);
  }
  renderBatchControls();
}

async function selectSession(id) {
  const data = await request(`/api/sessions/${encodeURIComponent(id)}`);
  current = data.session;
  renameMode = false;
  renderSessions();
  renderCurrent();
  startLiveRefresh();
}

function newChat() {
  current = null;
  renameMode = false;
  renderSessions();
  renderCurrent();
  stopLiveRefresh();
}

function renderCurrent() {
  $("empty").style.display = current ? "none" : "grid";
  $("messages").innerHTML = "";
  $("titleInput").disabled = true;
  $("titleInput").value = current?.title || "New chat";
  $("sideContinue").disabled = !current;
  $("sidePin").disabled = !current;
  $("sideRename").disabled = !current;
  $("sideDelete").disabled = !current;
  $("sideSnapshot").disabled = !current;
  $("promptInput").placeholder = current ? "Message this chat" : "Start a new chat";
  $("sendBtn").disabled = sending;
  renderTasks();
  renderPermissions();
  renderQuestions();

  if (!current) {
    $("meta").textContent = "No chat selected";
    $("sidePin").textContent = "Pin";
    $("detailStatus").textContent = "New chat";
    $("detailUpdated").textContent = "Not started";
    $("detailModel").textContent = "Default";
    $("detailTokens").textContent = "0";
    return;
  }

  $("sidePin").textContent = current.pinned ? "Unpin" : "Pin";
  $("meta").textContent = `${fmtTime(current.updated)} | ${shortPath(current.directory)}`;
  $("detailStatus").textContent = current.pinned ? "Pinned history" : "History";
  $("detailUpdated").textContent = fmtTime(current.updated);
  $("detailModel").textContent = current.model || current.agent || "-";
  $("detailTokens").textContent = `${current.tokensInput || 0} in / ${current.tokensOutput || 0} out`;

  for (const message of current.messages) {
    if (message.aborted && !message.text) continue;
    if (!message.text && !message.extras.length && !message.activities?.length) continue;
    const node = document.createElement("article");
    const text = cleanMessageText(message.text || "");
    const metadataOnly = !text && message.extras.length;
    node.className = `message ${message.role}${metadataOnly ? " metadata-only" : ""}`;
    node.innerHTML = `
      <div class="role">${message.role === "user" ? "You" : "OpenCode"}</div>
      <div class="bubble">
        <div class="content">${text ? renderMessageText(text, message.localPaths || []) : ""}</div>
        ${renderActivities(message.activities || [])}
        ${message.error ? `<div class="status-bar error-text">${escapeHtml(message.error)}</div>` : ""}
      </div>
    `;
    for (const pathButton of node.querySelectorAll("[data-local-path]")) {
      pathButton.addEventListener("click", () => openLocalPathMenu(pathButton.dataset.localPath));
    }
    $("messages").appendChild(node);
  }
  $("messages").scrollTop = $("messages").scrollHeight;
}

function renderActivities(activities) {
  if (!activities.length) return "";
  return `<div class="activity-list">${activities.map((activity) => {
    const detail = activity.detail ? `<pre>${escapeHtml(activity.detail)}</pre>` : "";
    return `
      <details class="activity-item ${escapeHtml(activity.status || "")}" ${activity.status === "running" ? "open" : ""}>
        <summary>
          <span class="activity-dot"></span>
          <span>${escapeHtml(activity.label || activity.type)}</span>
          <small>${escapeHtml(activity.status || "")}</small>
        </summary>
        ${detail}
      </details>
    `;
  }).join("")}</div>`;
}

function renderTasks() {
  const panel = $("taskPanel");
  const todos = current?.todos || [];
  panel.classList.toggle("visible", todos.length > 0);
  if (!todos.length) {
    panel.innerHTML = "";
    return;
  }
  const completed = todos.filter((todo) => todo.status === "completed").length;
  panel.innerHTML = `
    <details ${completed < todos.length ? "open" : ""}>
      <summary>Tasks <span>${completed}/${todos.length}</span></summary>
      <div class="task-list">
        ${todos.map((todo) => `
          <div class="task-item ${escapeHtml(todo.status || "pending")}">
            <span class="task-mark"></span>
            <span>${escapeHtml(todo.content || "")}</span>
            <small>${escapeHtml(todo.status || "pending")}</small>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

function renderBatchControls() {
  $("selectModeBtn").textContent = selectMode ? "Cancel" : "Select";
  $("deleteSelectedBtn").disabled = !selectMode || selectedIds.size === 0;
  $("deleteSelectedBtn").textContent = selectedIds.size ? `Delete ${selectedIds.size}` : "Delete selected";
}

function toggleSelectMode() {
  selectMode = !selectMode;
  selectedIds.clear();
  renderSessions();
}

function toggleSelected(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  renderSessions();
}

async function togglePin() {
  if (!current) return;
  await request(`/api/sessions/${encodeURIComponent(current.id)}/pin`, {
    method: "POST",
    body: JSON.stringify({ pinned: !current.pinned }),
  });
  current.pinned = !current.pinned;
  await loadSessions();
  renderCurrent();
}

async function rename() {
  if (!current) return;
  if (!renameMode) {
    renameMode = true;
    $("titleInput").disabled = false;
    $("titleInput").focus();
    $("titleInput").select();
    $("sideRename").textContent = "Save";
    return;
  }
  const title = $("titleInput").value.trim();
  await request(`/api/sessions/${encodeURIComponent(current.id)}/rename`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  current.title = title;
  renameMode = false;
  $("sideRename").textContent = "Rename";
  await loadSessions();
  renderCurrent();
}

async function openCurrent() {
  if (!current) return;
  const data = await request(`/api/sessions/${encodeURIComponent(current.id)}/open`, { method: "POST" });
  if (!data.ok) {
    await navigator.clipboard.writeText(data.command);
    alert(`Copied command: ${data.command}`);
  }
}

async function openCli() {
  setComposerStatus("Opening OpenCode terminal...");
  try {
    await request("/api/open-terminal", {
      method: "POST",
      body: JSON.stringify({ sessionID: current?.id || "" }),
    });
    setComposerStatus("");
  } catch (error) {
    setComposerStatus(error.message);
  }
}

async function deleteCurrent() {
  if (!current) return;
  const title = current.title || current.id;
  const confirmed = confirm(`Delete this chat permanently?\n\n${title}`);
  if (!confirmed) return;
  const deletedID = current.id;
  await request(`/api/sessions/${encodeURIComponent(deletedID)}/delete`, { method: "POST" });
  current = null;
  await loadSessions();
  renderCurrent();
}

async function deleteSelected() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const confirmed = confirm(`Delete ${ids.length} selected chat${ids.length > 1 ? "s" : ""} permanently?`);
  if (!confirmed) return;
  const data = await request("/api/sessions/delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
  const failed = data.results?.filter((item) => !item.ok) || [];
  if (current && ids.includes(current.id)) current = null;
  selectedIds.clear();
  selectMode = false;
  await loadSessions();
  renderCurrent();
  if (failed.length) alert(`Deleted with ${failed.length} failure(s).`);
}

async function createSnapshot() {
  if (!current) return;
  const confirmed = confirm(`Create a Balanced context snapshot for this chat?\n\n${current.title || current.id}\n\nThe original chat will not be changed.`);
  if (!confirmed) return;
  $("sideSnapshot").disabled = true;
  $("sideSnapshot").textContent = "Creating...";
  try {
    const data = await request(`/api/sessions/${encodeURIComponent(current.id)}/snapshot`, { method: "POST" });
    await loadSessions();
    if (data.sessionID) await selectSession(data.sessionID);
  } finally {
    $("sideSnapshot").textContent = "Balanced snapshot";
    renderCurrent();
  }
}

async function openNew() {
  const data = await request("/api/open-new", { method: "POST" });
  if (data.sessionID) {
    await loadSessions();
    await selectSession(data.sessionID);
    return;
  }
  if (!data.ok) {
    await navigator.clipboard.writeText(data.command);
    alert(`Copied command: ${data.command}`);
  }
}

async function loadModels() {
  const data = await request("/api/models");
  modelOptions = Array.isArray(data.models) ? data.models : [];
  renderModels();
}

async function loadPermissions() {
  const data = await request("/api/permissions");
  permissions = Array.isArray(data.permissions) ? data.permissions : [];
  renderPermissions();
}

function renderPermissions() {
  const panel = $("permissionPanel");
  const visiblePermissions = permissions.filter((item) => !current || !item.sessionID || item.sessionID === current.id);
  panel.classList.toggle("visible", visiblePermissions.length > 0);
  if (!visiblePermissions.length) {
    panel.innerHTML = "";
    return;
  }
  panel.innerHTML = visiblePermissions.map((item) => `
    <div class="permission-card" data-permission-id="${escapeHtml(item.id)}">
      <div class="permission-title">Permission required: ${escapeHtml(item.permission)}</div>
      <div class="permission-detail">${escapeHtml(item.summary || item.patterns?.join(", ") || "")}</div>
      <div class="permission-actions">
        <button class="small-button primary" data-permission-reply="once">Allow once</button>
        <button class="small-button" data-permission-reply="always">Always allow</button>
        <button class="small-button danger" data-permission-reply="reject">Reject</button>
      </div>
    </div>
  `).join("");
  for (const button of panel.querySelectorAll("[data-permission-reply]")) {
    button.addEventListener("click", () => {
      const card = button.closest("[data-permission-id]");
      replyPermission(card?.dataset.permissionId, button.dataset.permissionReply);
    });
  }
}

async function replyPermission(id, reply) {
  if (!id || !reply) return;
  setComposerStatus("Sending permission reply...");
  try {
    await request(`/api/permissions/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply }),
    });
    await loadPermissions();
    if (current) await refreshCurrentSession({ force: true, refreshList: true });
    setComposerStatus("");
  } catch (error) {
    setComposerStatus(error.message);
  }
}

async function loadQuestions() {
  const data = await request("/api/questions");
  questions = Array.isArray(data.questions) ? data.questions : [];
  renderQuestions();
}

function renderQuestions() {
  const panel = $("questionPanel");
  const visibleQuestions = questions.filter((item) => !current || !item.sessionID || item.sessionID === current.id);
  panel.classList.toggle("visible", visibleQuestions.length > 0);
  if (!visibleQuestions.length) {
    panel.innerHTML = "";
    return;
  }
  panel.innerHTML = visibleQuestions.map((item) => {
    const groups = (item.questions || []).map((question, questionIndex) => {
      const type = question.multiple ? "checkbox" : "radio";
      const name = `question-${item.id}-${questionIndex}`;
      const options = (question.options || []).map((option) => `
        <label class="question-option">
          <input type="${type}" name="${escapeHtml(name)}" value="${escapeHtml(option.label)}" />
          <span><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span>
        </label>
      `).join("");
      const custom = question.custom === false ? "" : `
        <input class="question-custom" name="${escapeHtml(name)}-custom" type="text" placeholder="Other answer" />
      `;
      return `
        <fieldset class="question-group" data-question-index="${questionIndex}">
          <legend>${escapeHtml(question.header || `Question ${questionIndex + 1}`)}</legend>
          <p>${escapeHtml(question.question || "")}</p>
          <div class="question-options">${options}${custom}</div>
        </fieldset>
      `;
    }).join("");
    return `
      <form class="question-card" data-question-id="${escapeHtml(item.id)}">
        ${groups}
        <div class="question-actions">
          <button class="small-button primary" type="submit">Submit answer</button>
          <button class="small-button danger" type="button" data-question-reject>Reject</button>
        </div>
      </form>
    `;
  }).join("");
  for (const form of panel.querySelectorAll("[data-question-id]")) {
    form.addEventListener("submit", (event) => submitQuestion(event, form));
    form.querySelector("[data-question-reject]")?.addEventListener("click", () => rejectQuestion(form.dataset.questionId));
  }
}

async function submitQuestion(event, form) {
  event.preventDefault();
  const answers = [...form.querySelectorAll("[data-question-index]")].map((group) => {
    const selected = [...group.querySelectorAll("input:checked")].map((input) => input.value);
    const custom = group.querySelector(".question-custom")?.value.trim();
    if (custom) selected.push(custom);
    return selected;
  });
  if (answers.some((answer) => answer.length === 0)) {
    setComposerStatus("Select or enter an answer for every question.");
    return;
  }
  setComposerStatus("Sending answer...");
  try {
    await request(`/api/questions/${encodeURIComponent(form.dataset.questionId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ answers }),
    });
    await loadQuestions();
    setComposerStatus("");
  } catch (error) {
    setComposerStatus(error.message);
  }
}

async function rejectQuestion(id) {
  if (!id) return;
  setComposerStatus("Rejecting question...");
  try {
    await request(`/api/questions/${encodeURIComponent(id)}/reject`, { method: "POST" });
    await loadQuestions();
    setComposerStatus("");
  } catch (error) {
    setComposerStatus(error.message);
  }
}

function renderModels() {
  const search = $("modelSearch");
  const selected = selectedModel ? modelOptions.find((model) => modelValue(model) === modelValue(selectedModel)) : null;
  if (selected) {
    search.value = selected.label;
    search.dataset.value = modelValue(selected);
  } else if (!document.activeElement || document.activeElement !== search) {
    search.value = "";
    search.dataset.value = "";
  }
  renderModelMenu();
}

function changeModel() {
  const value = $("modelSearch").dataset.value || "";
  selectedModel = value ? splitModelValue(value) : null;
  localStorage.setItem("historyBrowser:model", JSON.stringify(selectedModel));
  renderModels();
}

function searchModels() {
  $("modelSearch").dataset.value = "";
  renderModelMenu(true);
}

function resetModel() {
  selectedModel = null;
  $("modelSearch").dataset.value = "";
  localStorage.setItem("historyBrowser:model", JSON.stringify(selectedModel));
  renderModels();
}

function renderModelMenu(open = false) {
  const search = $("modelSearch");
  const menu = $("modelMenu");
  const needle = search.value.trim().toLowerCase();
  const selectedValue = selectedModel ? modelValue(selectedModel) : "";
  const matches = modelOptions
    .filter((model) => !needle || model.label.toLowerCase().includes(needle) || model.providerID.toLowerCase().includes(needle) || model.modelID.toLowerCase().includes(needle))
    .sort((a, b) => {
      if (a.default && !b.default) return -1;
      if (!a.default && b.default) return 1;
      return a.label.localeCompare(b.label);
    });
  menu.classList.toggle("visible", open || document.activeElement === search);
  if (!matches.length) {
    menu.innerHTML = '<div class="model-empty">No matching models</div>';
    return;
  }
  menu.innerHTML = matches.map((model) => {
    const value = modelValue(model);
    const selected = value === selectedValue ? " selected" : "";
    const badge = model.default ? '<span class="model-badge">default</span>' : "";
    return `
      <button class="model-option${selected}" type="button" data-model-value="${escapeHtml(value)}">
        <span class="model-label">${escapeHtml(model.label)}</span>
        ${badge}
      </button>
    `;
  }).join("");
  for (const option of menu.querySelectorAll("[data-model-value]")) {
    option.addEventListener("click", () => {
      search.dataset.value = option.dataset.modelValue;
      selectedModel = splitModelValue(option.dataset.modelValue);
      localStorage.setItem("historyBrowser:model", JSON.stringify(selectedModel));
      renderModels();
      menu.classList.remove("visible");
    });
  }
}

function modelValue(model) {
  return `${model.providerID}::${model.modelID}`;
}

function splitModelValue(value) {
  const [providerID, ...rest] = String(value || "").split("::");
  const modelID = rest.join("::");
  return providerID && modelID ? { providerID, modelID } : null;
}

function applyTheme() {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = selectedTheme === "system" ? (systemDark ? "dark" : "light") : selectedTheme;
  $("themeSelect").value = selectedTheme;
}

function changeTheme() {
  selectedTheme = $("themeSelect").value || "system";
  localStorage.setItem("historyBrowser:theme", selectedTheme);
  applyTheme();
}

async function sendPrompt(event) {
  event.preventDefault();
  if (sending) return;
  const text = $("promptInput").value.trim();
  const files = attachments.map(({ filename, mime, url }) => ({ filename, mime, url }));
  if (promptWatcher) {
    if (!text && !files.length) await abortPrompt(activePromptSessionID);
    else setComposerStatus("OpenCode is still responding. Wait for it to finish or press Stop with an empty input.");
    return;
  }
  if (!text && !files.length) return;
  if (text.startsWith("/") && !files.length) {
    await runBrowserCommand(text);
    return;
  }
  const optimisticSessionID = current?.id;
  const beforeSignature = messageSignature(current);
  sending = true;
  $("sendBtn").disabled = true;
  $("sendBtn").textContent = "Sending";
  setComposerStatus("Sending to OpenCode...");
  try {
    let sessionID = current?.id;
    if (!sessionID) {
      const created = await request("/api/open-new", { method: "POST" });
      sessionID = created.sessionID;
      if (!sessionID) throw new Error("New chat was not created.");
    }
    $("promptInput").value = "";
    if (optimisticSessionID === sessionID && current) {
      current.messages.push({ id: "", role: "user", created: Date.now(), text: text || "[Image]", extras: files.map((file) => file.filename) });
      renderCurrent();
    }
    const result = await request(`/api/sessions/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text, files, model: selectedModel || undefined }),
    });
    attachments = [];
    renderAttachments();
    setComposerStatus(result.method === "tui" ? "Submitted to OpenCode" : "Submitted");
    await loadSessions();
    await selectSession(sessionID);
    watchPrompt(sessionID, beforeSignature);
  } catch (error) {
    setComposerStatus(error.message);
  } finally {
    sending = false;
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = promptWatcher ? "Stop" : "Send";
    resizePrompt();
  }
}

async function runBrowserCommand(value) {
  const [command] = value.trim().split(/\s+/, 1);
  $("commandMenu").classList.remove("visible");
  if (command === "/skills") {
    await openSkillsDialog();
  } else if (command === "/mcp") {
    await openMcpDialog();
  } else {
    setComposerStatus("Available commands: /skills, /mcp");
    return;
  }
  $("promptInput").value = "";
  resizePrompt();
  setComposerStatus("");
}

function renderCommandMenu() {
  resizePrompt();
  const input = $("promptInput").value.trim();
  const menu = $("commandMenu");
  if (!input.startsWith("/") || input.includes(" ")) {
    menu.classList.remove("visible");
    menu.innerHTML = "";
    return;
  }
  const matches = browserCommands.filter((item) => item.command.startsWith(input.toLowerCase()));
  menu.classList.toggle("visible", matches.length > 0);
  menu.innerHTML = matches.map((item) => `
    <button class="command-option" type="button" data-browser-command="${item.command}">
      <code>${item.command}</code>
      <span>${item.label}</span>
    </button>
  `).join("");
  for (const option of menu.querySelectorAll("[data-browser-command]")) {
    option.addEventListener("click", () => {
      $("promptInput").value = option.dataset.browserCommand;
      runBrowserCommand(option.dataset.browserCommand);
    });
  }
}

function openUtilityDialog(title, content) {
  $("utilityTitle").textContent = title;
  $("utilityBody").innerHTML = content;
  $("utilityDialog").showModal();
}

async function openSkillsDialog() {
  openUtilityDialog("Skills", '<div class="utility-loading">Loading skills...</div>');
  try {
    const data = await request("/api/skills");
    const skills = Array.isArray(data.skills) ? data.skills : [];
    $("utilityBody").innerHTML = skills.length ? skills.map((skill) => `
      <article class="utility-item">
        <strong>${escapeHtml(skill.name)}</strong>
        <p>${escapeHtml(skill.description || "No description")}</p>
        <small>${escapeHtml(skill.location || "")}</small>
      </article>
    `).join("") : '<div class="utility-empty">No skills found.</div>';
  } catch (error) {
    $("utilityBody").innerHTML = `<div class="utility-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function openMcpDialog() {
  openUtilityDialog("MCP", '<div class="utility-loading">Loading MCP status...</div>');
  try {
    const data = await request("/api/mcp");
    const servers = Array.isArray(data.servers) ? data.servers : [];
    $("utilityBody").innerHTML = servers.length ? servers.map((server) => `
      <article class="utility-item utility-row">
        <strong>${escapeHtml(server.name)}</strong>
        <span class="status-pill ${escapeHtml(server.status || "")}">${escapeHtml(server.status || "unknown")}</span>
        ${server.error ? `<small>${escapeHtml(server.error)}</small>` : ""}
      </article>
    `).join("") : '<div class="utility-empty">No MCP servers configured.</div>';
  } catch (error) {
    $("utilityBody").innerHTML = `<div class="utility-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function abortPrompt(sessionID) {
  if (!sessionID) return;
  $("sendBtn").disabled = true;
  setComposerStatus("Stopping OpenCode...");
  try {
    await request(`/api/sessions/${encodeURIComponent(sessionID)}/abort`, { method: "POST" });
    clearPromptWatcher();
    await selectSession(sessionID);
    await loadSessions();
    setComposerStatus("");
  } catch (error) {
    setComposerStatus(error.message);
  } finally {
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = "Send";
  }
}

function watchPrompt(sessionID, beforeSignature) {
  clearPromptWatcher();
  activePromptSessionID = sessionID;
  $("sendBtn").disabled = false;
  $("sendBtn").textContent = "Stop";
  const startedAt = Date.now();
  let lastSignature = beforeSignature;
  let stableTicks = 0;
  let sawAssistant = false;
  promptWatcher = window.setInterval(async () => {
    if (current?.id !== sessionID) return clearPromptWatcher();
    if (Date.now() - startedAt > promptMaxWaitMs) {
      setComposerStatus("");
      return clearPromptWatcher();
    }
    try {
      await refreshCurrentSession({ force: true, refreshList: true });
      const signature = messageSignature(current);
      const finalAssistant = completedAssistantMessage(current, startedAt);
      if (hasNewAssistantMessage(current, startedAt) || (signature !== beforeSignature && lastRole(current) !== "user")) {
        sawAssistant = true;
        setComposerStatus(finalAssistant?.error ? "OpenCode returned an error" : "OpenCode is responding...");
      }
      stableTicks = sawAssistant && signature === lastSignature ? stableTicks + 1 : 0;
      lastSignature = signature;
      if (finalAssistant || (sawAssistant && stableTicks >= promptStableFallbackTicks)) {
        setComposerStatus("");
        clearPromptWatcher();
      }
    } catch {
      clearPromptWatcher();
    }
  }, promptPollMs);
}

function startLiveRefresh() {
  stopLiveRefresh();
  if (!current) return;
  liveRefreshTimer = window.setInterval(() => {
    refreshCurrentSession({ refreshList: liveRefreshTicks % 4 === 0 }).catch(() => {});
    liveRefreshTicks += 1;
  }, promptPollMs);
}

function stopLiveRefresh() {
  if (!liveRefreshTimer) return;
  window.clearInterval(liveRefreshTimer);
  liveRefreshTimer = null;
  liveRefreshTicks = 0;
}

async function refreshCurrentSession({ force = false, refreshList = false } = {}) {
  if (!current || liveRefreshInFlight || renameMode || document.hidden) return;
  liveRefreshInFlight = true;
  try {
    const sessionID = current.id;
    const previous = sessionStateSignature(current);
    const data = await request(`/api/sessions/${encodeURIComponent(sessionID)}`);
    if (current?.id !== sessionID) return;
    current = data.session;
    const next = sessionStateSignature(current);
    if (force || previous !== next) {
      renderCurrent();
      renderSessions();
    }
    if (refreshList) await loadSessions();
    await loadPermissions();
    await loadQuestions();
  } finally {
    liveRefreshInFlight = false;
  }
}

function clearPromptWatcher() {
  if (!promptWatcher) return;
  window.clearInterval(promptWatcher);
  promptWatcher = null;
  activePromptSessionID = null;
  if (!sending) $("sendBtn").textContent = "Send";
}

function setComposerStatus(text) {
  $("composerStatus").textContent = text;
}

function messageSignature(session) {
  return (session?.messages || [])
    .slice(-6)
    .map((message) => `${message.role}:${message.id}:${message.created}:${message.completed || 0}:${message.error || ""}:${(message.text || "").length}:${JSON.stringify(message.activities || []).length}`)
    .join("|");
}

function sessionStateSignature(session) {
  return `${session?.updated || 0}:${session?.title || ""}:${session?.model || ""}:${session?.tokensInput || 0}:${session?.tokensOutput || 0}:${JSON.stringify(session?.todos || []).length}:${messageSignature(session)}`;
}

function hasNewAssistantMessage(session, startedAt) {
  return (session?.messages || []).some((message) => {
    return message.role !== "user" && message.text && (!message.created || message.created >= startedAt - 1000);
  });
}

function lastRole(session) {
  const messages = (session?.messages || []).filter((message) => message.text || message.extras?.length);
  return messages[messages.length - 1]?.role || "";
}

function completedAssistantMessage(session, startedAt) {
  return [...(session?.messages || [])].reverse().find((message) => {
    return message.role !== "user" && (message.completed || message.error) && (!message.created || message.created >= startedAt - 1000);
  });
}

function resizePrompt() {
  $("promptInput").style.height = "auto";
  $("promptInput").style.height = `${Math.min($("promptInput").scrollHeight, 140)}px`;
}

function openImagePicker() {
  $("imageInput").click();
}

async function addImages(files) {
  const images = [...files].filter((file) => file.type.startsWith("image/")).slice(0, 8 - attachments.length);
  for (const file of images) {
    const url = await readFileAsDataUrl(file);
    attachments.push({
      filename: file.name || "image",
      mime: file.type || "image/png",
      url,
    });
  }
  renderAttachments();
}

function imageFilesFromClipboard(event) {
  const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
  const itemFiles = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const seen = new Set();
  return [...files, ...itemFiles].filter((file) => {
    const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderAttachments() {
  const list = $("attachmentList");
  list.classList.toggle("visible", attachments.length > 0);
  list.innerHTML = attachments.map((file, index) => `
    <div class="attachment-chip">
      <img src="${escapeHtml(file.url)}" alt="" />
      <span class="attachment-name">${escapeHtml(file.filename)}</span>
      <button class="attachment-remove" type="button" data-attachment-index="${index}" aria-label="Remove attachment">x</button>
    </div>
  `).join("");
  for (const button of list.querySelectorAll("[data-attachment-index]")) {
    button.addEventListener("click", () => {
      attachments.splice(Number(button.dataset.attachmentIndex), 1);
      renderAttachments();
    });
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image."));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cleanMessageText(value) {
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderMessageText(text, localPaths) {
  const paths = [...new Map(
    localPaths
      .filter((item) => item?.path)
      .map((item) => [String(item.path).toLowerCase(), item])
  ).values()].sort((a, b) => b.path.length - a.path.length);
  if (!paths.length) return escapeHtml(text);

  const lower = text.toLowerCase();
  const matches = [];
  for (const item of paths) {
    const needle = item.path.toLowerCase();
    let index = lower.indexOf(needle);
    while (index >= 0) {
      matches.push({ index, end: index + item.path.length, item });
      index = lower.indexOf(needle, index + needle.length);
    }
  }
  matches.sort((a, b) => a.index - b.index || b.end - a.end);

  let cursor = 0;
  let output = "";
  for (const match of matches) {
    if (match.index < cursor) continue;
    output += escapeHtml(text.slice(cursor, match.index));
    const label = text.slice(match.index, match.end);
    output += `<button class="local-path" type="button" data-local-path="${escapeHtml(match.item.path)}" title="Local path">${escapeHtml(label)}</button>`;
    cursor = match.end;
  }
  return output + escapeHtml(text.slice(cursor));
}

async function openLocalPathMenu(path) {
  openUtilityDialog("Local path", '<div class="utility-loading">Checking path...</div>');
  try {
    const data = await request("/api/local-path", {
      method: "POST",
      body: JSON.stringify({ path, action: "info" }),
    });
    const fileActions = data.type === "file"
      ? '<button type="button" data-path-action="reveal">Show in folder</button>'
      : "";
    $("utilityBody").innerHTML = `
      <div class="local-path-dialog">
        <code>${escapeHtml(data.path)}</code>
        <div class="local-path-actions">
          <button class="primary" type="button" data-path-action="open">${data.type === "directory" ? "Open folder" : "Open"}</button>
          ${fileActions}
          <button type="button" data-path-action="copy">Copy path</button>
        </div>
      </div>
    `;
    for (const button of $("utilityBody").querySelectorAll("[data-path-action]")) {
      button.addEventListener("click", async () => {
        const action = button.dataset.pathAction;
        if (action === "copy") {
          await copyText(data.path);
          button.textContent = "Copied";
          return;
        }
        await request("/api/local-path", {
          method: "POST",
          body: JSON.stringify({ path: data.path, action }),
        });
        $("utilityDialog").close();
      });
    }
  } catch (error) {
    $("utilityBody").innerHTML = `<div class="utility-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {}
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function readStoredJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function heartbeat() {
  request("/api/heartbeat", { method: "POST" }).catch(() => {});
}

function notifyBrowserClose() {
  if (!apiToken || !navigator.sendBeacon) return;
  navigator.sendBeacon(`/api/browser-close?token=${encodeURIComponent(apiToken)}`);
}

$("refresh").onclick = loadSessions;
$("openNewBtn").onclick = openNew;
$("newChatBtn").onclick = openNew;
$("openCli").onclick = openCli;
$("sideContinue").onclick = openCurrent;
$("sideSnapshot").onclick = createSnapshot;
$("sidePin").onclick = togglePin;
$("sideRename").onclick = rename;
$("sideDelete").onclick = deleteCurrent;
$("selectModeBtn").onclick = toggleSelectMode;
$("deleteSelectedBtn").onclick = deleteSelected;
$("modelSearch").addEventListener("input", searchModels);
$("modelSearch").addEventListener("focus", () => renderModelMenu(true));
$("modelSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    const first = $("modelMenu").querySelector("[data-model-value]");
    if (first) first.click();
  }
  if (event.key === "Escape") $("modelMenu").classList.remove("visible");
});
$("modelReset").onclick = resetModel;
$("themeSelect").onchange = changeTheme;
$("attachBtn").onclick = openImagePicker;
$("imageInput").addEventListener("change", (event) => {
  addImages(event.target.files || []).catch((error) => setComposerStatus(error.message));
  event.target.value = "";
});
$("composer").onsubmit = sendPrompt;
$("search").addEventListener("input", () => {
  clearTimeout(window.__searchTimer);
  window.__searchTimer = setTimeout(loadSessions, 180);
});
$("promptInput").addEventListener("input", renderCommandMenu);
$("promptInput").addEventListener("paste", handleImagePaste);
document.addEventListener("paste", handleImagePaste);
function handleImagePaste(event) {
  const files = imageFilesFromClipboard(event);
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  addImages(files).catch((error) => setComposerStatus(error.message));
}
$("promptInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("titleInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") rename();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !promptWatcher) return;
  event.preventDefault();
  abortPrompt(activePromptSessionID);
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".model-picker")) $("modelMenu").classList.remove("visible");
  if (!event.target.closest(".composer")) $("commandMenu").classList.remove("visible");
});
$("utilityClose").onclick = () => $("utilityDialog").close();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
window.addEventListener("pagehide", notifyBrowserClose);

applyTheme();
heartbeat();
window.setInterval(heartbeat, 10000);
window.setInterval(() => loadPermissions().catch(() => {}), promptPollMs);
window.setInterval(() => loadQuestions().catch(() => {}), promptPollMs);
renderCurrent();
loadSessions().catch((error) => {
  $("empty").innerHTML = `<div class="new-chat-box"><div class="new-chat-title">Load failed</div><p>${escapeHtml(error.message)}</p></div>`;
});
loadModels().catch(() => {
  $("modelSearch").placeholder = "Follow OpenCode";
});
loadPermissions().catch(() => {});
loadQuestions().catch(() => {});
