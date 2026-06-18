import test from "node:test";
import assert from "node:assert/strict";
import { buildBalancedSnapshot } from "../lib/browser-snapshot.js";
import { inferPluginName, inferSkillScope, normalizeMcpServer } from "../lib/browser-diagnostics.js";

test("infers plugin metadata for bundled and system skills", () => {
  assert.equal(
    inferPluginName({ name: "omo:debugging", location: "C:/Users/feng/.codex/plugins/cache/sisyphuslabs/omo/4.10.0/skills/debugging/SKILL.md" }),
    "sisyphuslabs",
  );
  assert.equal(
    inferPluginName({ name: "openai-docs", location: "C:/Users/feng/.codex/skills/.system/openai-docs/SKILL.md" }),
    "builtin",
  );
  assert.equal(inferSkillScope({ name: "omo:debugging", location: "x" }), "plugin");
  assert.equal(inferSkillScope({ name: "openai-docs", location: "C:/Users/feng/.codex/skills/.system/openai-docs/SKILL.md" }), "system");
  assert.equal(inferSkillScope({ name: "custom-skill", location: "D:/workspace/.codex/skills/custom/SKILL.md" }), "workspace");
});

test("normalizes MCP server status for dialog rendering", () => {
  assert.deepEqual(
    normalizeMcpServer("filesystem", {
      connected: true,
      command: ["node", "server.js"],
      cwd: "D:/codex",
      transport: "stdio",
      source: "workspace",
      capabilities: { tools: [{ name: "read" }, { name: "write" }] },
    }),
    {
      name: "filesystem",
      status: "connected",
      connected: true,
      tools: 2,
      command: "node server.js",
      cwd: "D:/codex",
      error: "",
      transport: "stdio",
      source: "workspace",
    },
  );
});

test("builds a balanced snapshot with decisions, errors, commands, and open work", () => {
  const text = buildBalancedSnapshot({
    id: "ses_123",
    title: "Plugin fixes",
    directory: "D:/codex/opencode-history-browser",
    updated: Date.UTC(2026, 5, 18, 1, 2, 3),
    todos: [
      { content: "Push the final fixes to GitHub", status: "pending" },
      { content: "Already done", status: "completed" },
    ],
    messages: [
      { role: "user", text: "Fix continue chat failure and use Balanced snapshot." },
      { role: "assistant", text: "Decision: switch browser prompts to promptAsync. Command: `opencode.cmd plugin --global --force github:wa52/opencode-history-browser-next`" },
      { role: "assistant", text: "Error: MessageAbortedError: Aborted after the CLI attach flow failed." },
    ],
  });

  assert.match(text, /## Decisions And Constraints/);
  assert.match(text, /promptAsync/);
  assert.match(text, /## Errors And Risks/);
  assert.match(text, /MessageAbortedError/);
  assert.match(text, /## Commands And References/);
  assert.match(text, /opencode\.cmd plugin --global --force/);
  assert.match(text, /## Open Work/);
  assert.match(text, /Push the final fixes to GitHub/);
});
