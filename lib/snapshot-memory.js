function buildStructuredMemory(session) {
  const messages = annotateMessages(session.messages);
  const goal = inferGoal(messages);
  const current = currentState(messages);
  const decisions = extractKeywordRecords(messages, [
    /\b(?:decision|decided|choose|chosen|resolved|plan|next step|constraint)\b[^\n]*/gi,
    /(?:决定|已改为|改成|采用|方案|约束|下一步)[^\n。]{0,140}/g,
  ], 10);
  const errors = extractKeywordRecords(messages, [
    /\b(?:error|failed|failure|exception|abort|aborted|timeout|denied|warning)\b[^\n]*/gi,
    /(?:错误|失败|异常|中断|超时|拒绝|警告)[^\n。]{0,140}/g,
  ], 10);
  const artifacts = extractKeywordRecords(messages, [
    /[A-Za-z]:\\[^\s"'<>|]+/g,
    /(?:\.\/|\.\.\/|\/)[^\s"'<>|]+/g,
  ], 16);
  const commands = extractKeywordRecords(messages, [
    /`([^`]{2,200})`/g,
    /\b(?:opencode|npm|node|git|powershell|cmd(?:\.exe)?)\b[^\n]*/gi,
  ], 12);
  const openWork = (Array.isArray(session.todos) ? session.todos : [])
    .filter((todo) => todo.status !== "completed")
    .map((todo, index) => ({
      ref: `T${index + 1}`,
      value: clip(todo.content, 180),
    }));
  const recent = messages.slice(-6).map((message) => ({
    ref: message.ref,
    role: message.role,
    value: clip(message.text || message.fallback || "", 320),
  })).filter((item) => item.value.trim().length > 3);
  const sourceIndex = messages
    .filter((message) => (message.text || message.fallback || "").trim())
    .slice(-12)
    .map((message) => ({
      ref: message.ref,
      role: message.role,
      created: message.created,
      value: clip(message.text || message.fallback || "", 180),
    }));

  return {
    goal,
    current,
    decisions,
    errors,
    artifacts,
    commands,
    openWork,
    recent,
    sourceIndex,
  };
}

function annotateMessages(input) {
  const source = Array.isArray(input) ? input : [];
  return source.map((message, index) => ({
    ref: `M${index + 1}`,
    role: message.role === "user" ? "User" : "Assistant",
    text: String(message.text || "").trim(),
    fallback: Array.isArray(message.extras) ? message.extras.join(", ") : "",
    created: message.created || message.completed || 0,
  }));
}

function inferGoal(messages) {
  const firstUser = messages.find((message) => message.role === "User" && message.text);
  if (!firstUser) return {
    value: "Continue the previous OpenCode task using the structured context below.",
    ref: "",
  };
  return {
    value: clip(firstUser.text, 420),
    ref: firstUser.ref,
  };
}

function currentState(messages) {
  const assistant = [...messages].reverse().find((message) => message.role !== "User" && message.text);
  const user = [...messages].reverse().find((message) => message.role === "User" && message.text);
  const lines = [];
  if (assistant) lines.push({ label: "Last assistant state", value: clip(assistant.text, 520), ref: assistant.ref });
  if (user) lines.push({ label: "Latest user request", value: clip(user.text, 420), ref: user.ref });
  return lines.length ? lines : [{ label: "Current state", value: "No clear current state was detected.", ref: "" }];
}

function extractKeywordRecords(messages, patterns, limit) {
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
        output.push({ ref: message.ref, value });
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

export { buildStructuredMemory };
