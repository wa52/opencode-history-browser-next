import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const id = "opencode-history-browser";
let serverProcess;

async function tui(api) {
  const start = () => {
    if (!serverProcess || serverProcess.exitCode !== null) {
      const root = dirname(fileURLToPath(import.meta.url));
      const app = join(root, "app.py");
      serverProcess = spawn(process.env.PYTHON || "python", [app], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      serverProcess.unref();
    }

    const url = "http://127.0.0.1:8765";
    openUrl(url);
    api.ui.toast({
      variant: "success",
      title: "History Browser",
      message: `Opened ${url}`,
      duration: 4000,
    });
  };

  api.command.register(() => [
    {
      title: "Open History Browser",
      value: "history-browser.open",
      description: "Open a ChatGPT-style browser UI for OpenCode history.",
      category: "History",
      slash: {
        name: "history-browser",
        aliases: ["history-ui", "chat-history"],
      },
      onSelect: start,
    },
  ]);
}

function openUrl(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

export default { id, tui };
