import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "opencode-history-browser-next";
const PLUGIN_TITLE = "OpenCode History Browser Next";
const REPOSITORY_SPEC = "github:wa52/opencode-history-browser-next";
const CONFIG_DIR = join(homedir(), ".config", "opencode");
const KV_FILE = join(CONFIG_DIR, "history-browser-next-kv.json");
const LOCK_FILE = join(CONFIG_DIR, "history-browser-next.lock");
const LOG_FILE = join(CONFIG_DIR, "history-browser-next.log");
const LAUNCHER_NAME = "OpenCode Browser Next.vbs";
const LAUNCHER_FILE = join(CONFIG_DIR, LAUNCHER_NAME);
const REDIRECT_MARKER = "OPENCODE_HISTORY_BROWSER_NEXT_REDIRECT";
const REDIRECT_BACKUP_BASENAME = "opencode-history-browser-next-original";
const KV_PREFIX = "history-browser-next:";

export {
  CONFIG_DIR,
  KV_FILE,
  KV_PREFIX,
  LAUNCHER_FILE,
  LAUNCHER_NAME,
  LOCK_FILE,
  LOG_FILE,
  PLUGIN_ID,
  PLUGIN_TITLE,
  REDIRECT_MARKER,
  REDIRECT_BACKUP_BASENAME,
  REPOSITORY_SPEC,
};
