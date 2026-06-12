import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isOpenCodeCommand(command) {
  return typeof command === "string" &&
    /(?:^|[\\/])opencode(?:-cli)?(?:\.(?:exe|cmd|bat))?$/i.test(command.trim());
}

function commandLaunch(command, args, mode = "wait") {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      command: "cmd.exe",
      args: ["/d", mode === "keep" ? "/k" : "/c", "call", command, ...args],
    };
  }
  return { command, args };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function buildMacTerminalCommand(command, args, cwd) {
  const executable = [command, ...args].map(shellQuote).join(" ");
  return `cd ${shellQuote(cwd)} && OPENCODE_HISTORY_CLI=1 exec ${executable}`;
}

function linuxTerminalLaunch(terminal, command, args) {
  const name = terminal.split(/[\\/]/).at(-1)?.toLowerCase();
  if (name === "gnome-terminal") return { command: terminal, args: ["--", command, ...args] };
  return { command: terminal, args: ["-e", command, ...args] };
}

async function commandExists(command) {
  try {
    await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [command], {
      timeout: 5000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function commandCandidates(preferredCommand) {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  if (process.platform !== "win32") {
    return [preferredCommand, process.env.OPENCODE_BINARY, "opencode"];
  }
  return [
    preferredCommand,
    process.env.OPENCODE_BINARY,
    join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
    join(appData, "npm", "opencode.exe"),
    join(appData, "npm", "opencode-cli.cmd"),
    "opencode-cli.cmd",
    "opencode.exe",
    "opencode.cmd",
    "opencode",
  ];
}

async function resolveOpenCodeCommand(preferredCommand) {
  const candidates = [...new Set(commandCandidates(preferredCommand).filter(isOpenCodeCommand))];
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && existsSync(candidate)) return candidate;
    if (!isAbsolute(candidate) && await commandExists(candidate)) return candidate;
  }
  throw new Error("OpenCode CLI executable was not found. Run `where opencode` and reinstall this plugin.");
}

export {
  buildMacTerminalCommand,
  commandExists,
  commandLaunch,
  isOpenCodeCommand,
  linuxTerminalLaunch,
  resolveOpenCodeCommand,
};
