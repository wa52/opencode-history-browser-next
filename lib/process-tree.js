import { spawnSync } from "node:child_process";

async function stopProcessTree(pid, platform = process.platform) {
  if (!pid) return;
  if (platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }

  signalProcessTree(pid, "SIGTERM");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  signalProcessTree(pid, "SIGKILL");
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline) {
    if (!processGroupExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process group ${pid} did not stop.`);
}

function stopProcessTreeSync(pid, platform = process.platform) {
  if (!pid) return;
  if (platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  signalProcessTree(pid, "SIGKILL");
}

function signalProcessTree(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export { stopProcessTree, stopProcessTreeSync };
