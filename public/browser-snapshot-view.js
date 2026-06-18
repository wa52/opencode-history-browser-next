import { escapeHtml, renderPathText } from "./browser-utils.js";

function isSnapshotMessage(message, session) {
  if (!message || message.role !== "user") return false;
  if (session?.metadata?.snapshotMode === "balanced") {
    return /^# Context Snapshot\b/m.test(String(message.text || ""));
  }
  return /^# Context Snapshot\b/m.test(String(message.text || ""));
}

function renderSnapshotMessage(message) {
  const parsed = parseSnapshotText(message.text || "");
  if (!parsed.title) return "";
  return `
    <section class="snapshot-view">
      <header class="snapshot-header">
        <div class="snapshot-kicker">Compressed context</div>
        <h3>${escapeHtml(parsed.title)}</h3>
      </header>
      ${parsed.sections.map(renderSection).join("")}
    </section>
  `;
}

function parseSnapshotText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sections = [];
  let title = "";
  let section = null;
  let subgroup = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("# ")) {
      title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith("## ")) {
      section = { title: line.slice(3).trim(), items: [], groups: [] };
      sections.push(section);
      subgroup = null;
      continue;
    }
    if (line.startsWith("### ")) {
      if (!section) continue;
      subgroup = { title: line.slice(4).trim(), items: [] };
      section.groups.push(subgroup);
      continue;
    }
    if (line.startsWith("- ")) {
      const item = line.slice(2).trim();
      if (subgroup) subgroup.items.push(item);
      else if (section) section.items.push(item);
      continue;
    }
    if (subgroup) subgroup.items.push(line);
    else if (section) section.items.push(line);
  }

  return { title, sections };
}

function renderSection(section) {
  const items = renderItems(section.items);
  const groups = section.groups.map((group) => `
    <div class="snapshot-group">
      <div class="snapshot-group-title">${escapeHtml(group.title)}</div>
      ${renderItems(group.items)}
    </div>
  `).join("");
  return `
    <section class="snapshot-section">
      <div class="snapshot-section-title">${escapeHtml(section.title)}</div>
      ${items}
      ${groups}
    </section>
  `;
}

function renderItems(items) {
  if (!items.length) return "";
  return `<ul class="snapshot-list">${items.map((item) => `<li>${renderPathText(item, [])}</li>`).join("")}</ul>`;
}

export { isSnapshotMessage, parseSnapshotText, renderSnapshotMessage };
