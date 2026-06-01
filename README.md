# OpenCode History Browser

ChatGPT-style local history UI for OpenCode.

## Install

```powershell
opencode plugin --global github:wa52/opencode-history-browser
```

Restart OpenCode. The browser UI opens automatically at a local URL.

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

## Features

- Left sidebar with all OpenCode sessions
- Search sessions
- Read chat content in a browser-like view
- Pin important chats
- Rename OpenCode session titles
- Delete chats
- Continue a selected chat in OpenCode
- Start a new chat from the browser view

## Requirements

- OpenCode installed on the machine
- No Python setup
- No database path setup
- No environment variables

## Update or Reinstall

```powershell
opencode plugin --global github:wa52/opencode-history-browser
```

Then fully restart OpenCode.

If the browser page does not refresh, press `Ctrl+F5`.

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
