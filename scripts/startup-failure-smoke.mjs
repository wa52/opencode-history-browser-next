import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "history-browser-next-"));
const runner = join(root, "runner.mjs");
const pidFile = join(root, "runner.pid");
const command = join(root, process.platform === "win32" ? "opencode.cmd" : "opencode");
const configHome = join(root, "home");
const lockFile = join(configHome, ".config", "opencode", "history-browser-next.lock");

try {
  await writeFile(
    runner,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    "utf8",
  );
  if (process.platform === "win32") {
    await writeFile(command, `@echo off\r\n"${process.execPath}" "${runner}"\r\n`, "utf8");
  } else {
    await writeFile(command, `#!/bin/sh\nexec "${process.execPath}" "${runner}"\n`, "utf8");
    await chmod(command, 0o755);
  }

  const host = spawn(process.execPath, ["standalone.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      HOME: configHome,
      USERPROFILE: configHome,
      OPENCODE_BINARY: command,
      OPENCODE_HISTORY_BROWSER_FAIL_AFTER_SPAWN: "1",
      OPENCODE_HISTORY_BROWSER_FAIL_DELAY_MS: "500",
      OPENCODE_HISTORY_BROWSER_NO_OPEN: "1",
    },
    stdio: "ignore",
  });
  const exitCode = await new Promise((resolve, reject) => {
    host.once("exit", resolve);
    host.once("error", reject);
  });
  assert.equal(exitCode, 1);
  await assert.rejects(readFile(lockFile, "utf8"), { code: "ENOENT" });

  const runnerPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
  assert.equal(processExists(runnerPid), false);
  console.log(JSON.stringify({ ok: true, exitCode, runnerPid }));
} finally {
  await rm(root, { recursive: true, force: true });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
