const $ = (id) => document.getElementById(id);

let sessions = [];
let current = null;
let renameMode = false;
let selectMode = false;
let sending = false;
const selectedIds = new Set();
const apiToken = new URLSearchParams(window.location.search).get("token") || "";

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
}

function newChat() {
  current = null;
  renameMode = false;
  renderSessions();
  renderCurrent();
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
    if (!message.text && !message.extras.length) continue;
    const node = document.createElement("article");
    node.className = `message ${message.role}`;
    node.innerHTML = `
      <div class="role">${message.role === "user" ? "You" : "OpenCode"}</div>
      <div class="bubble">
        ${escapeHtml(message.text || "")}
        ${message.extras.length ? `<div class="extra">${escapeHtml(message.extras.join(" | "))}</div>` : ""}
      </div>
    `;
    $("messages").appendChild(node);
  }
  $("messages").scrollTop = $("messages").scrollHeight;
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

async function sendPrompt(event) {
  event.preventDefault();
  if (sending) return;
  const text = $("promptInput").value.trim();
  if (!text) return;
  const optimisticSessionID = current?.id;
  sending = true;
  $("sendBtn").disabled = true;
  $("sendBtn").textContent = "Sending";
  try {
    let sessionID = current?.id;
    if (!sessionID) {
      const created = await request("/api/open-new", { method: "POST" });
      sessionID = created.sessionID;
      if (!sessionID) throw new Error("New chat was not created.");
    }
    $("promptInput").value = "";
    if (optimisticSessionID === sessionID && current) {
      current.messages.push({ id: "", role: "user", created: Date.now(), text, extras: [] });
      renderCurrent();
    }
    await request(`/api/sessions/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    await loadSessions();
    await selectSession(sessionID);
    schedulePromptRefresh(sessionID);
  } finally {
    sending = false;
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = "Send";
    resizePrompt();
  }
}

function schedulePromptRefresh(sessionID) {
  for (const delay of [1200, 3000, 6000, 10000]) {
    window.setTimeout(() => {
      if (current?.id === sessionID) selectSession(sessionID).catch(() => {});
    }, delay);
  }
}

function resizePrompt() {
  $("promptInput").style.height = "auto";
  $("promptInput").style.height = `${Math.min($("promptInput").scrollHeight, 140)}px`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

$("refresh").onclick = loadSessions;
$("openNewBtn").onclick = openNew;
$("sideContinue").onclick = openCurrent;
$("sideSnapshot").onclick = createSnapshot;
$("sidePin").onclick = togglePin;
$("sideRename").onclick = rename;
$("sideDelete").onclick = deleteCurrent;
$("selectModeBtn").onclick = toggleSelectMode;
$("deleteSelectedBtn").onclick = deleteSelected;
$("composer").onsubmit = sendPrompt;
$("search").addEventListener("input", () => {
  clearTimeout(window.__searchTimer);
  window.__searchTimer = setTimeout(loadSessions, 180);
});
$("promptInput").addEventListener("input", resizePrompt);
$("promptInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("titleInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") rename();
});

renderCurrent();
loadSessions().catch((error) => {
  $("empty").innerHTML = `<div class="new-chat-box"><div class="new-chat-title">Load failed</div><p>${escapeHtml(error.message)}</p></div>`;
});
