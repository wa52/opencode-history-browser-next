import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMacTerminalCommand,
  commandLaunch,
  isOpenCodeCommand,
  linuxTerminalLaunch,
} from "../lib/opencode-cli.js";

test("accepts only OpenCode command names", () => {
  assert.equal(isOpenCodeCommand("opencode"), true);
  assert.equal(isOpenCodeCommand("opencode-cli.cmd"), true);
  assert.equal(isOpenCodeCommand("C:\\Tools\\opencode.exe"), true);
  assert.equal(isOpenCodeCommand("F:\\Git\\cmd\\git.exe"), false);
  assert.equal(isOpenCodeCommand("node.exe"), false);
});

test("wraps Windows command shims through cmd", () => {
  const launch = commandLaunch("C:\\npm\\opencode-cli.cmd", ["--version"], "keep");
  if (process.platform === "win32") {
    assert.deepEqual(launch, {
      command: "cmd.exe",
      args: ["/d", "/k", "call", "C:\\npm\\opencode-cli.cmd", "--version"],
    });
  } else {
    assert.deepEqual(launch, {
      command: "C:\\npm\\opencode-cli.cmd",
      args: ["--version"],
    });
  }
});

test("builds a macOS terminal command that suppresses browser recursion", () => {
  const command = buildMacTerminalCommand(
    "/Applications/OpenCode's CLI/opencode",
    ["attach", "http://127.0.0.1:4096"],
    "/Users/feng/My Project",
  );

  assert.equal(
    command,
    "cd '/Users/feng/My Project' && OPENCODE_HISTORY_CLI=1 exec '/Applications/OpenCode'\\''s CLI/opencode' 'attach' 'http://127.0.0.1:4096'",
  );
});

test("uses each Linux terminal emulator's supported execution flag", () => {
  assert.deepEqual(linuxTerminalLaunch("gnome-terminal", "opencode", ["attach", "url"]), {
    command: "gnome-terminal",
    args: ["--", "opencode", "attach", "url"],
  });
  assert.deepEqual(linuxTerminalLaunch("/usr/bin/konsole", "opencode", ["attach", "url"]), {
    command: "/usr/bin/konsole",
    args: ["-e", "opencode", "attach", "url"],
  });
});
