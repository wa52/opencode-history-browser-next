const $ = (id) => document.getElementById(id);

let sessions = [];
let current = null;
let renameMode = false;

const fmtTime = (ms) => {
  if (!ms) return "未知时间";
  return new Date(ms).toLocaleString();
};

const shortPath = (path) => {
  if (!path) return "未知目录";
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
};

const request = async (url, options) => {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
};

async function loadSessions() {
  const q = $("search").value.trim();
  const data = await request(`/api/sessions?q=${encodeURIComponent(q)}`);
  sessions = data.sessions;
  renderSessions();
  if (!current && sessions.length) selectSession(sessions[0].id);
}

function renderSessions() {
  $("sessionList").innerHTML = "";
  for (const session of sessions) {
    const item = document.createElement("button");
    item.className = `session-item ${current?.id === session.id ? "active" : ""}`;
    item.onclick = () => selectSession(session.id);
    const preview = session.preview?.[0]?.text || session.directory || "";
    item.innerHTML = `
      <div class="session-title">${session.pinned ? "<span>★</span>" : ""}<span>${escapeHtml(session.title || "Untitled")}</span></div>
      <div class="session-preview">${escapeHtml(preview)}</div>
      <div class="session-time">${fmtTime(session.updated)} · ${escapeHtml(shortPath(session.directory))}</div>
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

function renderCurrent() {
  $("empty").style.display = current ? "none" : "block";
  $("messages").innerHTML = "";
  $("titleInput").disabled = true;
  $("titleInput").value = current?.title || "";
  $("pinBtn").disabled = !current;
  $("renameBtn").disabled = !current;
  $("openBtn").disabled = !current;
  if (!current) return;

  $("pinBtn").textContent = current.pinned ? "取消置顶" : "置顶";
  $("meta").textContent = `${fmtTime(current.updated)} · ${shortPath(current.directory)} · ${current.id}`;

  for (const message of current.messages) {
    if (!message.text && !message.extras.length) continue;
    const node = document.createElement("article");
    node.className = `message ${message.role}`;
    node.innerHTML = `
      <div class="role">${message.role === "user" ? "你" : "OpenCode"}</div>
      <div class="bubble">
        ${escapeHtml(message.text || "")}
        ${message.extras.length ? `<div class="extra">${escapeHtml(message.extras.join(" · "))}</div>` : ""}
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
    $("renameBtn").textContent = "保存";
    return;
  }
  const title = $("titleInput").value.trim();
  await request(`/api/sessions/${encodeURIComponent(current.id)}/rename`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  current.title = title;
  renameMode = false;
  $("renameBtn").textContent = "重命名";
  await loadSessions();
  renderCurrent();
}

async function openCurrent() {
  if (!current) return;
  const data = await request(`/api/sessions/${encodeURIComponent(current.id)}/open`, { method: "POST" });
  if (!data.ok) {
    await navigator.clipboard.writeText(data.command);
    alert(`已复制命令：${data.command}`);
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
$("pinBtn").onclick = togglePin;
$("renameBtn").onclick = rename;
$("openBtn").onclick = openCurrent;
$("search").addEventListener("input", () => {
  clearTimeout(window.__searchTimer);
  window.__searchTimer = setTimeout(loadSessions, 180);
});
$("titleInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") rename();
});

loadSessions().catch((error) => {
  $("empty").innerHTML = `<h2>读取失败</h2><p>${escapeHtml(error.message)}</p>`;
});
