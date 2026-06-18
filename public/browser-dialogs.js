const browserCommands = [
  { command: "/skills", label: "View installed skills" },
  { command: "/mcp", label: "View MCP status" },
  { command: "/logs", label: "View browser error logs" },
  { command: "/uninstall", label: "Uninstall this plugin" },
];

function createBrowserDialogs({
  $,
  escapeHtml,
  request,
  resizePrompt,
  setComposerStatus,
}) {
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
          <div class="utility-row">
            <strong>${escapeHtml(skill.name)}</strong>
            <span class="status-pill">${escapeHtml(skill.scope || "unknown")}</span>
          </div>
          <p>${escapeHtml(skill.description || "No description")}</p>
          <small>Plugin: ${escapeHtml(skill.plugin || "builtin")}</small>
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
        <article class="utility-item">
          <div class="utility-row">
            <strong>${escapeHtml(server.name)}</strong>
            <span class="status-pill ${escapeHtml(server.status || "")}">${escapeHtml(server.status || "unknown")}</span>
          </div>
          <p>${escapeHtml(server.connected ? "Connected" : "Not connected")} · ${escapeHtml(String(server.tools || 0))} tools${server.transport ? ` · ${escapeHtml(server.transport)}` : ""}</p>
          ${server.command ? `<small>Command: ${escapeHtml(server.command)}</small>` : ""}
          ${server.cwd ? `<small>Folder: ${escapeHtml(server.cwd)}</small>` : ""}
          ${server.source ? `<small>Source: ${escapeHtml(server.source)}</small>` : ""}
          ${server.error ? `<small>${escapeHtml(server.error)}</small>` : ""}
        </article>
      `).join("") : '<div class="utility-empty">No MCP servers configured.</div>';
    } catch (error) {
      $("utilityBody").innerHTML = `<div class="utility-empty">${escapeHtml(error.message)}</div>`;
    }
  }

  async function openLogsDialog() {
    openUtilityDialog("History Browser logs", '<div class="utility-loading">Loading logs...</div>');
    try {
      const data = await request("/api/logs");
      $("utilityBody").innerHTML = `
        <div class="log-toolbar">
          <code title="${escapeHtml(data.path || "")}">${escapeHtml(data.path || "history-browser-next.log")}</code>
          <div>
            <button id="openLogFile" class="small-button" type="button">Open file</button>
            <button id="clearLogFile" class="small-button" type="button">Clear</button>
          </div>
        </div>
        <pre class="log-output">${escapeHtml(data.content || "No log entries yet.")}</pre>
      `;
      $("openLogFile").onclick = async () => request("/api/logs/open", { method: "POST" });
      $("clearLogFile").onclick = async () => {
        await request("/api/logs/clear", { method: "POST" });
        await openLogsDialog();
      };
    } catch (error) {
      $("utilityBody").innerHTML = `<div class="utility-empty">${escapeHtml(error.message)}</div>`;
    }
  }

  async function uninstallPlugin() {
    const confirmed = confirm("Uninstall History Browser?\n\nThis only removes the plugin and restores the original opencode command. OpenCode itself will keep working after restart.");
    if (!confirmed) return;
    setComposerStatus("Uninstalling History Browser...");
    try {
      const data = await request("/api/uninstall", { method: "POST" });
      openUtilityDialog("History Browser uninstalled", `
        <div class="utility-empty">
          <p>${escapeHtml(data.message || "Plugin removed.")}</p>
          <small>${data.redirectRestored ? "Original opencode command restored." : "No command redirect needed to be restored."}</small>
          <small>${escapeHtml((data.removed || []).join("\n"))}</small>
        </div>
      `);
      setComposerStatus("Uninstalled. Restart OpenCode to finish.");
    } catch (error) {
      setComposerStatus(error.message);
    }
  }

  async function runBrowserCommand(value) {
    const [command] = value.trim().split(/\s+/, 1);
    $("commandMenu").classList.remove("visible");
    if (command === "/skills") {
      await openSkillsDialog();
    } else if (command === "/mcp") {
      await openMcpDialog();
    } else if (command === "/logs") {
      await openLogsDialog();
    } else if (command === "/uninstall") {
      await uninstallPlugin();
    } else {
      setComposerStatus("Available commands: /skills, /mcp, /logs, /uninstall");
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

  return {
    browserCommands,
    openLogsDialog,
    openMcpDialog,
    openSkillsDialog,
    openUtilityDialog,
    renderCommandMenu,
    runBrowserCommand,
    uninstallPlugin,
  };
}

export { browserCommands, createBrowserDialogs };
