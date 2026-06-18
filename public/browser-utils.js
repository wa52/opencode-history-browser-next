function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function cleanMessageText(value) {
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderPathText(text, paths) {
  const matches = [];
  const value = String(text || "");
  const lower = value.toLowerCase();
  for (const item of paths || []) {
    const label = String(item?.label || "");
    if (!label) continue;
    const needle = label.toLowerCase();
    let index = lower.indexOf(needle);
    while (index >= 0) {
      matches.push({ index, end: index + label.length, item });
      index = lower.indexOf(needle, index + needle.length);
    }
  }
  matches.sort((a, b) => a.index - b.index || b.end - a.end);

  let cursor = 0;
  let output = "";
  for (const match of matches) {
    if (match.index < cursor) continue;
    output += escapeHtml(value.slice(cursor, match.index));
    output += `<button class="openable-path ${escapeHtml(match.item.type)}" type="button" data-open-path="${escapeHtml(match.item.path)}" title="${match.item.type === "directory" ? "Open folder" : "Open file"}">${escapeHtml(value.slice(match.index, match.end))}</button>`;
    cursor = match.end;
  }
  return output + escapeHtml(value.slice(cursor));
}

function bindPathActions(root, { request, setComposerStatus }) {
  for (const button of root.querySelectorAll("[data-open-path]")) {
    button.addEventListener("click", async () => {
      const path = button.dataset.openPath;
      try {
        button.disabled = true;
        await request("/api/local-path", {
          method: "POST",
          body: JSON.stringify({ path, action: "open" }),
        });
      } catch (error) {
        setComposerStatus(error.message);
      } finally {
        button.disabled = false;
      }
    });
  }
}

function readStoredJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image."));
    reader.readAsDataURL(file);
  });
}

function imageFilesFromClipboard(event) {
  const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
  const itemFiles = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const seen = new Set();
  return [...files, ...itemFiles].filter((file) => {
    const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export {
  bindPathActions,
  cleanMessageText,
  escapeHtml,
  imageFilesFromClipboard,
  readFileAsDataUrl,
  readStoredJson,
  renderPathText,
};
