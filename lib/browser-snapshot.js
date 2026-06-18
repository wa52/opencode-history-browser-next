import { buildStructuredMemory } from "./snapshot-memory.js";

function buildBalancedSnapshot(session) {
  const memory = buildStructuredMemory(session);

  return [
    "# Context Snapshot",
    "",
    "Use this mixed compressed context to continue the work. The original OpenCode session is preserved separately.",
    "",
    "## Source",
    `- Title: ${session.title || "Untitled"}`,
    `- Session ID: ${session.id}`,
    `- Folder: ${session.workspaceRoot || session.directory || "Unknown"}`,
    `- Updated: ${session.updated ? new Date(session.updated).toLocaleString() : "Unknown"}`,
    `- Snapshot mode: Balanced mixed memory`,
    "",
    "## Compression Policy",
    "- Keep a short tail of recent conversation verbatim enough to preserve flow.",
    "- Preserve long-lived state as structured memory instead of replaying the entire transcript.",
    "- Track where each extracted item came from through message references.",
    "",
    "## Goal",
    renderSingle(memory.goal, "- No clear goal was detected automatically."),
    "",
    "## Current State",
    ...renderLabeled(memory.current),
    "",
    "## Structured Memory",
    "### Decisions And Constraints",
    ...renderRecords(memory.decisions, "- No explicit decision trail was detected automatically."),
    "",
    "### Errors And Risks",
    ...renderRecords(memory.errors, "- No active errors were detected automatically."),
    "",
    "### Artifacts And Paths",
    ...renderRecords(memory.artifacts, "- No high-signal paths or artifacts were detected automatically."),
    "",
    "### Commands And References",
    ...renderRecords(memory.commands, "- No command or code reference snippets were detected automatically."),
    "",
    "### Open Work",
    ...renderRecords(memory.openWork, "- No unfinished todo items were reported by OpenCode."),
    "",
    "## Recent Messages",
    ...renderRecent(memory.recent),
    "",
    "## Source Index",
    ...renderSourceIndex(memory.sourceIndex),
    "",
    "## Next Steps",
    "- Continue from this snapshot instead of re-reading the entire original session.",
    "- Use the source index when exact wording or omitted detail matters.",
    "- Ask for the original session if you need logs, full tool output, or precise chronology beyond the indexed excerpts.",
  ].join("\n");
}

function renderSingle(record, fallback) {
  if (!record?.value) return fallback;
  return `- ${record.ref ? `[${record.ref}] ` : ""}${record.value}`;
}

function renderLabeled(records) {
  return records.map((record) => `- ${record.label}: ${record.ref ? `[${record.ref}] ` : ""}${record.value}`);
}

function renderRecords(records, fallback) {
  if (!records.length) return [fallback];
  return records.map((record) => `- [${record.ref}] ${record.value}`);
}

function renderRecent(records) {
  if (!records.length) return ["- No recent message text was available."];
  return records.map((record) => `- [${record.ref}] ${record.role}: ${record.value}`);
}

function renderSourceIndex(records) {
  if (!records.length) return ["- No source messages were available for indexing."];
  return records.map((record) => `- [${record.ref}] ${record.role}${record.created ? ` @ ${new Date(record.created).toLocaleString()}` : ""}: ${record.value}`);
}

export { buildBalancedSnapshot };
