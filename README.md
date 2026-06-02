# OpenCode History Browser

Browser UI for OpenCode sessions, installed as a global OpenCode TUI plugin.

## Install

Copy this into OpenCode or a terminal:

```powershell
opencode plugin --global github:wa52/opencode-history-browser
```

Restart OpenCode. The browser opens automatically.

If it does not open, run this in OpenCode:

```text
/history-browser
```

## What You Get

- Browser-style chat UI for OpenCode history
- Continue chats from the browser input
- Start a new chat
- Stop an active reply
- Pin, rename, delete, and multi-delete chats
- Search all sessions
- Create a Balanced context snapshot
- Open OpenCode panels from the browser: Models, Sessions, Help, Themes

## Update

```powershell
opencode plugin --global --force github:wa52/opencode-history-browser
```

Restart OpenCode after updating.

## Uninstall

Run this inside OpenCode:

```text
/history-browser-uninstall
```

Then fully restart OpenCode.

## Requirements

- OpenCode installed
- No Python
- No manual database path
- No environment variables

## Troubleshooting

If `/history-browser` is missing after restart, run the update command above and restart OpenCode again.

On Windows, if PowerShell blocks `opencode.ps1`, use the `.cmd` command:

```powershell
opencode.cmd plugin --global --force github:wa52/opencode-history-browser
```

The browser URL contains a temporary token. Reopen it with `/history-browser` instead of reusing an old URL.
