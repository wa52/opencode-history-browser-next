# OpenCode History Browser

ChatGPT-style local history UI for OpenCode.

## Install

```powershell
opencode plugin --global github:wa52/opencode-history-browser
```

Restart OpenCode. The browser UI opens automatically.

You can also open it from OpenCode:

```text
/history-browser
/history-ui
/chat-history
```

Manual URL, if needed:

```text
http://127.0.0.1:8765
```

## Local development

The OpenCode plugin is self-contained and does not need Python.

The legacy standalone launcher is still available for local development:

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
- Delete chats, with an automatic database backup before deletion
- Continue a chat by opening a new PowerShell window with `opencode --session <id>`

Pin state is stored in:

```text
C:\Users\<you>\.config\opencode\history-browser.json
```

OpenCode sessions are read from:

```text
C:\Users\<you>\.local\share\opencode\opencode.db
```

Delete backups are stored in:

```text
C:\Users\<you>\.local\share\opencode\history-browser-backups
```

## Requirements

- OpenCode installed on the machine
- No Python setup needed when installed through `opencode plugin`

## Troubleshooting

Update/reinstall:

```powershell
opencode plugin --global github:wa52/opencode-history-browser
```

Then fully restart OpenCode.

If the browser page does not refresh, press `Ctrl+F5`.
