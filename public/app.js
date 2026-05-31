const $ = (id) => document.getElementById(id);

let sessions = [];
let current = null;
let renameMode = false;

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : "Unknown time");

const shortPath = (path) => {
  if (!path) return "Unknown folder";
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
};

const request = async (url, options) => {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
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
    item.className = `session-item ${current?.id === session.id ? "active" : ""}`;
    item.onclick = () => selectSession(session.id);
    const preview = session.preview?.[0]?.text || session.directory || "";
    item.innerHTML = `
      <div class="session-title">${session.pinned ? "<span class=\"pin\">Pinned</span>" : ""}<span>${escapeHtml(session.title || "Untitled")}</span></div>
      <div class="session-preview">${escapeHtml(preview)}</div>
      <div class="session-time">${fmtTime(session.updated)} | ${escapeHtml(shortPath(session.directory))}</div>
    `;
    $("sessionList").appendChild(item);
  }
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
  $("pinBtn").disabled = !current;
  $("renameBtn").disabled = !current;
  $("deleteBtn").disabled = !current;
  $("openBtn").disabled = !current;
  $("composerContinue").disabled = !current;
  $("sideContinue").disabled = !current;
  $("sidePin").disabled = !current;
  $("sideRename").disabled = !current;
  $("sideDelete").disabled = !current;
  $("renameBtn").textContent = "Rename";

  if (!current) {
    $("meta").textContent = "No chat selected";
    $("pinBtn").textContent = "Pin";
    $("sidePin").textContent = "Pin";
    $("detailStatus").textContent = "New chat";
    $("detailFolder").textContent = "-";
    $("detailUpdated").textContent = "-";
    $("detailModel").textContent = "-";
    $("detailTokens").textContent = "-";
    $("detailId").textContent = "-";
    return;
  }

  $("pinBtn").textContent = current.pinned ? "Unpin" : "Pin";
  $("sidePin").textContent = current.pinned ? "Unpin" : "Pin";
  $("meta").textContent = `${fmtTime(current.updated)} | ${shortPath(current.directory)} | ${current.id}`;
  $("detailStatus").textContent = current.pinned ? "Pinned history" : "History";
  $("detailFolder").textContent = current.directory || "-";
  $("detailUpdated").textContent = fmtTime(current.updated);
  $("detailModel").textContent = current.model || current.agent || "-";
  $("detailTokens").textContent = `${current.tokensInput || 0} in / ${current.tokensOutput || 0} out`;
  $("detailId").textContent = current.id;

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
    $("renameBtn").textContent = "Save";
    return;
  }
  const title = $("titleInput").value.trim();
  await request(`/api/sessions/${encodeURIComponent(current.id)}/rename`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  current.title = title;
  renameMode = false;
  $("renameBtn").textContent = "Rename";
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
  const confirmed = confirm(`Delete this chat permanently?\n\n${title}\n\nA database backup will be created before deletion.`);
  if (!confirmed) return;
  const deletedID = current.id;
  const data = await request(`/api/sessions/${encodeURIComponent(deletedID)}/delete`, { method: "POST" });
  current = null;
  await loadSessions();
  renderCurrent();
  alert(`Deleted. Backup created:\n${data.backup}`);
}

async function openNew() {
  const data = await request("/api/open-new", { method: "POST" });
  if (!data.ok) {
    await navigator.clipboard.writeText(data.command);
    alert(`Copied command: ${data.command}`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

$("refresh").onclick = loadSessions;
$("newBtn").onclick = newChat;
$("openNewBtn").onclick = openNew;
$("pinBtn").onclick = togglePin;
$("renameBtn").onclick = rename;
$("deleteBtn").onclick = deleteCurrent;
$("openBtn").onclick = openCurrent;
$("composerContinue").onclick = openCurrent;
$("sideContinue").onclick = openCurrent;
$("sidePin").onclick = togglePin;
$("sideRename").onclick = rename;
$("sideDelete").onclick = deleteCurrent;
$("search").addEventListener("input", () => {
  clearTimeout(window.__searchTimer);
  window.__searchTimer = setTimeout(loadSessions, 180);
});
$("titleInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") rename();
});

renderCurrent();
loadSessions().catch((error) => {
  $("empty").innerHTML = `<div class="new-chat-box"><div class="new-chat-title">Load failed</div><p>${escapeHtml(error.message)}</p></div>`;
});
