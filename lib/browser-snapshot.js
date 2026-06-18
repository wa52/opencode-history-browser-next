function buildBalancedSnapshot(session) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const facts = importantLines(messages);
  const recent = messages.slice(-8).map((message) => {
    const speaker = message.role === "user" ? "User" : "Assistant";
    return `- ${speaker}: ${clip(message.text || message.extras?.join(", ") || "", 280)}`;
  }).filter((line) => line.trim().length > 10);
  const decisions = extractKeywordLines(messages, [
    /\b(?:decision|decided|choose|chosen|resolved|plan|next step|constraint)\b[^\n]*/gi,
    /(?:决定|已改为|改成|采用|方案|约束|下一步)[^\n。]{0,140}/g,
  ], 10);
  const errors = extractKeywordLines(messages, [
    /\b(?:error|failed|failure|exception|abort|aborted|timeout|denied|warning)\b[^\n]*/gi,
    /(?:错误|失败|异常|中断|超时|拒绝|警告)[^\n。]{0,140}/g,
  ], 10);
  const commands = extractKeywordLines(messages, [
    /`([^`]{2,200})`/g,
    /\b(?:opencode|npm|node|git|powershell|cmd(?:\.exe)?)\b[^\n]*/gi,
  ], 12);
  const todos = (Array.isArray(session.todos) ? session.todos : [])
    .filter((todo) => todo.status !== "completed")
    .map((todo) => clip(todo.content, 180));

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
    "## Decisions And Constraints",
    ...(decisions.length ? decisions.map((line) => `- ${line}`) : ["- No explicit decision trail was detected automatically."]),
    "",
    "## Errors And Risks",
    ...(errors.length ? errors.map((line) => `- ${line}`) : ["- No active errors were detected automatically."]),
    "",
    "## Important Details",
    ...(facts.length ? facts.map((line) => `- ${line}`) : ["- No high-signal paths, commands, errors, or decisions were detected automatically."]),
    "",
    "## Commands And References",
    ...(commands.length ? commands.map((line) => `- ${line}`) : ["- No command or code reference snippets were detected automatically."]),
    "",
    "## Open Work",
    ...(todos.length ? todos.map((line) => `- ${line}`) : ["- No unfinished todo items were reported by OpenCode."]),
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
    /[A-Za-z]:\\\\[^\s"'<>|]+/g,
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

function extractKeywordLines(messages, patterns, limit) {
  const seen = new Set();
  const output = [];
  for (const message of messages) {
    const text = String(message.text || "");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const raw = match[1] || match[0];
        const value = clip(String(raw).replace(/\s+/g, " ").trim(), 220);
        const key = value.toLowerCase();
        if (value.length < 3 || seen.has(key)) continue;
        seen.add(key);
        output.push(value);
        if (output.length >= limit) return output;
      }
    }
  }
  return output;
}

function clip(text, max) {
  const value = String(text).replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

export { buildBalancedSnapshot };
