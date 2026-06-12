import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { CONFIG_DIR, LOG_FILE } from "./lib/identity.js";

const maxLogBytes = 2 * 1024 * 1024;

async function writeLog(level, event, details = {}) {
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await rotateLogIfNeeded();
    const entry = {
      time: new Date().toISOString(),
      level,
      event,
      ...normalizeDetails(details),
    };
    await appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {}
}

function normalizeDetails(details) {
  if (details instanceof Error) {
    return {
      error: details.message,
      code: details.code,
      stack: details.stack,
    };
  }
  if (!details || typeof details !== "object") return { detail: String(details || "") };
  const output = {};
  for (const [key, value] of Object.entries(details)) {
    if (/token/i.test(key)) continue;
    if (value instanceof Error) {
      output[key] = value.message;
      output[`${key}Code`] = value.code;
      output[`${key}Stack`] = value.stack;
    } else if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

async function readLogs(limit = 400) {
  try {
    const text = await readFile(LOG_FILE, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-limit).join("\n");
  } catch (error) {
    if (error?.code === "ENOENT") await clearLogs();
    return "";
  }
}

async function clearLogs() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(LOG_FILE, "", "utf8");
}

async function rotateLogIfNeeded() {
  try {
    const details = await stat(LOG_FILE);
    if (details.size < maxLogBytes) return;
    await unlink(`${LOG_FILE}.1`).catch(() => {});
    await rename(LOG_FILE, `${LOG_FILE}.1`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export { clearLogs, LOG_FILE as logFile, readLogs, writeLog };
