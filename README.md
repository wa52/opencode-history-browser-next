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

Restart OpenCode once after installation. After that, running `opencode` with
no arguments opens the browser directly without showing the TUI loading page.

Use `opencode-cli` when you explicitly want the original OpenCode command-line
interface. Commands with arguments, such as `opencode plugin ...` and
`opencode --help`, continue to use the original OpenCode executable.

The browser's `Open CLI` button opens the selected session as an independent
terminal client. Closing that terminal does not stop or reload the browser.

On Windows, the plugin also creates `OpenCode Browser.vbs` on the desktop. Use
that shortcut afterward to start the browser UI without keeping an OpenCode
command window visible.

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
- Open an OpenCode command-line window from the browser
- Continue chats from the browser input
- Start a new chat
- Stop an active reply with Stop or Esc
- Pin, rename, delete, and multi-delete chats
- Search all sessions
- Create a Balanced context snapshot
- Reply to OpenCode questions, choices, and permission requests
- See reasoning stages, tool calls, tool results, and task progress
- Paste or attach images
- Search and select models
- Open detected local files with the system default app
- Open folders, reveal files in Explorer, and copy local paths
- Browser commands: `/skills` and `/mcp`
- Install self-check with `/history-browser-doctor`

Closing the browser also stops the hidden OpenCode host after a short grace
period. Reloading the page does not stop it.

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
