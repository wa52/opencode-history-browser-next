import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopProcessTree } from "../lib/process-tree.js";

test("stops a spawned process tree before resolving", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });

  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await stopProcessTree(child.pid);
  let timer;
  const exit = await Promise.race([
    exited,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Child process did not exit.")), 5_000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.notEqual(exit, undefined);
});

test("kills a POSIX descendant after its group leader exits", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "history-browser-tree-"));
  const childScript = join(root, "child.mjs");
  const parentScript = join(root, "parent.mjs");
  const pidFile = join(root, "child.pid");

  try {
    await writeFile(
      childScript,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`,
      "utf8",
    );
    await writeFile(
      parentScript,
      `import { spawn } from "node:child_process";\nspawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n`,
      "utf8",
    );
    const leader = spawn(process.execPath, [parentScript], { detached: true, stdio: "ignore" });
    await waitForFile(pidFile);
    const descendantPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);

    await stopProcessTree(leader.pid);
    assert.equal(processExists(descendantPid), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for descendant PID.");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
