function inferPluginName(skill) {
  const location = String(skill?.location || "");
  const cached = location.match(/plugins[\\/](?:cache|bundled)[\\/]+([^\\/]+)/i);
  if (cached?.[1]) return cached[1];
  const name = String(skill?.name || "");
  return name.includes(":") ? name.split(":")[0] : "builtin";
}

function inferSkillScope(skill) {
  const name = String(skill?.name || "");
  if (name.includes(":")) return "plugin";
  if (/[\\/]\.system[\\/]/.test(String(skill?.location || ""))) return "system";
  return "workspace";
}

function normalizeMcpServer(name, value) {
  const server = value && typeof value === "object" ? value : {};
  const tools = Array.isArray(server.tools)
    ? server.tools
    : Array.isArray(server.capabilities?.tools)
      ? server.capabilities.tools
      : [];
  return {
    name,
    status: server.status || (server.connected ? "connected" : "unknown"),
    connected: Boolean(server.connected ?? (server.status === "connected")),
    tools: tools.length,
    command: Array.isArray(server.command) ? server.command.join(" ") : (server.command || ""),
    cwd: server.cwd || server.workingDirectory || "",
    error: server.error || "",
    transport: server.transport || "",
    source: server.source || server.origin || "",
  };
}

export { inferPluginName, inferSkillScope, normalizeMcpServer };
