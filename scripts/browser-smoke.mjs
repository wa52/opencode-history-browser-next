import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { LOCK_FILE } from "../lib/identity.js";

let launched;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || await startStandalone();

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const bareUrl = url.replace(/\?.*$/, "");
  await page.goto(bareUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".shell");

  assert.equal(await page.title(), "OpenCode History Next");
  assert.equal((await page.locator(".brand h1").textContent())?.trim(), "History Next");
  assert.equal(await page.locator("#newChatBtn").isVisible(), true);
  assert.equal(await page.locator("#promptInput").isVisible(), true);

  await page.locator(".settings-card > summary").click();
  await page.locator("#modelSearch").fill("deepseek");
  await page.waitForSelector(".model-menu.visible");
  assert.equal(await page.locator(".model-menu").isVisible(), true);
  await page.locator("#modelReset").click();
  await page.locator("#viewLogs").click();
  await page.waitForSelector("#utilityDialog[open]");
  assert.match((await page.locator("#utilityTitle").textContent()) || "", /logs/i);
  assert.match((await page.locator(".log-toolbar code").textContent()) || "", /history-browser-next\.log/i);
  await page.locator("#utilityClose").click();

  await page.locator("#promptInput").fill("/skills");
  await page.locator("#promptInput").press("Enter");
  await page.waitForSelector("#utilityDialog[open]");
  assert.match((await page.locator("#utilityTitle").textContent()) || "", /skills/i);
  await page.locator("#utilityClose").click();

  await page.locator("#promptInput").fill("/mcp");
  await page.locator("#promptInput").press("Enter");
  await page.waitForSelector("#utilityDialog[open]");
  assert.match((await page.locator("#utilityTitle").textContent()) || "", /mcp/i);
  await page.locator("#utilityClose").click();

  await page.locator("#newChatBtn").click();
  await page.waitForFunction(() => document.getElementById("detailStatus")?.textContent?.trim() === "History");

  const screenshot = join(tmpdir(), "opencode-history-browser-next-smoke.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ ok: true, title: await page.title(), screenshot }));
} finally {
  await browser.close();
  if (launched?.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => launched.once("exit", resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Standalone browser did not shut down after idle.")), 10_000)),
    ]);
  }
}

async function startStandalone() {
  launched = spawn(process.execPath, ["standalone.js"], {
    cwd: join(scriptDir, ".."),
    env: {
      ...process.env,
      OPENCODE_HISTORY_BROWSER_IDLE_MS: "15000",
      OPENCODE_HISTORY_BROWSER_NO_OPEN: "1",
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (launched.exitCode !== null) {
      throw new Error(`Standalone browser exited with code ${launched.exitCode}.`);
    }
    try {
      const lock = JSON.parse(await readFile(LOCK_FILE, "utf8"));
      if (lock?.pid === launched.pid && lock?.url) return lock.url;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the standalone browser.");
}
