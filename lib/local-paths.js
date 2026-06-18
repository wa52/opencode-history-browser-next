import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

function resolveLocalPaths(text, workspace) {
  const value = String(text || "");
  const candidates = [];
  const seenLabels = new Set();
  const addCandidate = (label) => {
    const cleaned = cleanPathLabel(label);
    if (!cleaned || seenLabels.has(cleaned.toLowerCase())) return;
    seenLabels.add(cleaned.toLowerCase());
    candidates.push(cleaned);
  };

  for (const match of value.matchAll(/`([^`\r\n]+)`|["']([^"'\r\n]+)["']/g)) {
    addCandidate(match[1] || match[2]);
  }
  for (const line of value.split(/\r?\n/)) {
    for (const match of line.matchAll(/[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]/g)) {
      addCandidate(longestExistingPath(line.slice(match.index), workspace));
    }
  }
  for (const match of value.matchAll(/(?:^|[\s([{"'`|])((?:\.{1,2}[\\/])?(?:[^\s<>"'`|:]+[\\/])+[^\s<>"'`|:]+|(?:\.{1,2}[\\/])?[^\s<>"'`|:]+\.[A-Za-z0-9_-]{1,16})(?=$|[\s)\]},;:'"`|])/gmu)) {
    addCandidate(match[1]);
  }

  const output = [];
  const seenPaths = new Set();
  for (const label of candidates) {
    const target = isAbsolute(label) ? normalize(label) : resolve(workspace, label);
    let details;
    try {
      if (!existsSync(target)) continue;
      details = statSync(target);
    } catch {
      continue;
    }
    const key = `${label.toLowerCase()}\0${target.toLowerCase()}`;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    output.push({
      label,
      path: target,
      type: details.isDirectory() ? "directory" : "file",
    });
    if (output.length >= 40) break;
  }
  return output;
}

function longestExistingPath(raw, workspace) {
  let candidate = cleanPathLabel(
    String(raw || "")
      .split(/[<>"`|]/, 1)[0]
      .split(/\s+(?:not in|is not|does not|was not|outside|from|to)\s+/i, 1)[0]
  );
  for (let attempt = 0; candidate && attempt < 20; attempt += 1) {
    const target = isAbsolute(candidate) ? normalize(candidate) : resolve(workspace, candidate);
    if (existsSync(target)) return candidate;
    const cut = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\t"));
    if (cut < 0) break;
    candidate = cleanPathLabel(candidate.slice(0, cut));
  }
  return "";
}

function cleanPathLabel(value) {
  return String(value || "")
    .trim()
    .replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "")
    .replace(/^[([{<\u3008\u300a]+|[)\]}>.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f]+$/g, "");
}

function normalizeLocalPath(value) {
  const text = String(value || "")
    .trim()
    .replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "");
  return text ? normalize(text) : "";
}

async function localPathInfo(target) {
  try {
    const details = await stat(target);
    return { exists: true, type: details.isDirectory() ? "directory" : "file" };
  } catch {
    return { exists: false, type: "missing" };
  }
}

async function openLocalPath(target, type) {
  if (process.platform === "win32") {
    if (type === "directory") {
      await spawnDetached("explorer.exe", [target]);
    } else {
      await spawnDetached("rundll32.exe", ["url.dll,FileProtocolHandler", target]);
    }
    return;
  }
  await spawnDetached(process.platform === "darwin" ? "open" : "xdg-open", [target]);
}

async function revealLocalFile(target) {
  if (process.platform === "win32") {
    await spawnDetached("explorer.exe", [`/select,${target}`]);
    return;
  }
  if (process.platform === "darwin") {
    await spawnDetached("open", ["-R", target]);
    return;
  }
  await spawnDetached("xdg-open", [dirname(target)]);
}

function spawnDetached(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

export {
  localPathInfo,
  normalizeLocalPath,
  openLocalPath,
  resolveLocalPaths,
  revealLocalFile,
};
