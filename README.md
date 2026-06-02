# OpenCode History Browser

Browser UI for OpenCode sessions, installed as a global OpenCode TUI plugin.

## Install

Windows PowerShell or Command Prompt:

```powershell
opencode.cmd plugin --global github:wa52/opencode-history-browser
```

macOS, Linux, or a shell where `opencode` already works:

```sh
opencode plugin --global github:wa52/opencode-history-browser
```

Restart OpenCode. The browser opens automatically.

If it does not open, run this in OpenCode:

```text
/history-browser
```

To verify an install:

```text
/history-browser-doctor
```

## What You Get

- Browser-style chat UI for OpenCode history
- Continue chats from the browser input
- Start a new chat
- Stop an active reply with Stop or Esc
- Pin, rename, delete, and multi-delete chats
- Search all sessions
- Create a Balanced context snapshot
- Open OpenCode panels from the browser: Models, Sessions, Help, Themes
- Install self-check with `/history-browser-doctor`

## Update

Windows:

```powershell
opencode.cmd plugin --global --force github:wa52/opencode-history-browser
```

macOS/Linux:

```sh
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

On Windows, use `opencode.cmd` instead of `opencode` if PowerShell blocks `opencode.ps1`.

If the browser opens but history does not load, run `/history-browser-doctor` inside OpenCode.

The browser URL contains a temporary token. Reopen it with `/history-browser` instead of reusing an old URL.
