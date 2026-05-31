# OpenCode History Browser

ChatGPT-style local history UI for OpenCode.

## Install from GitHub

After this repo is uploaded to GitHub:

```powershell
npm install -g github:<your-name>/opencode-history-browser
opencode-history-browser
```

Open:

```text
http://127.0.0.1:8765
```

## Install as an OpenCode plugin

If your OpenCode build supports GitHub/npm plugin specs:

```powershell
opencode plugin --global github:<your-name>/opencode-history-browser
```

Then restart OpenCode and run:

```text
/history-browser
```

Aliases:

```text
/history-ui
/chat-history
```

## Local development

Double-click:

```text
D:\codex\opencode-history-browser\open-history-browser.cmd
```

Or run:

```powershell
powershell -ExecutionPolicy Bypass -File D:\codex\opencode-history-browser\start.ps1
```

## Features

- Left sidebar with all OpenCode sessions
- Search by title, directory, or session ID
- Read chat content in a browser-like view
- Pin important chats
- Rename OpenCode session titles
- Continue a chat by opening a new PowerShell window with `opencode --session <id>`

Pin state is stored in:

```text
C:\Users\<you>\.config\opencode\history-browser.json
```

OpenCode sessions are read from:

```text
C:\Users\<you>\.local\share\opencode\opencode.db
```

## Requirements

- OpenCode installed on the machine
- Python 3 available as `python`
- Node.js only for the global `npm install -g github:...` launcher
