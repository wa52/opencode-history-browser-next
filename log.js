import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const logDir = join(homedir(), ".config", "opencode");
const logFile = join(logDir, "history-browser.log");

async function writeLog(level, event, details = {}) {
  try {
    await mkdir(logDir, { recursive: true });
    const entry = {
      time: new Date().toISOString(),
      level,
      event,
      ...normalizeDetails(details),
    };
    await appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
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
    const text = await readFile(logFile, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-limit).join("\n");
  } catch {
    return "";
  }
}

async function clearLogs() {
  await mkdir(logDir, { recursive: true });
  await writeFile(logFile, "", "utf8");
}

export { clearLogs, logFile, readLogs, writeLog };
