# OpenCode History Browser Next

Browser UI for OpenCode sessions, installed as a global OpenCode TUI plugin.

This is the independent `next` edition. Uninstall the legacy
`github:wa52/opencode-history-browser` plugin before enabling this one because
both editions can redirect the same global `opencode` command on Windows.

## Install

Windows PowerShell or Command Prompt:

```powershell
opencode.cmd plugin --global github:wa52/opencode-history-browser-next
```

macOS, Linux, or a shell where `opencode` already works:

```sh
opencode plugin --global github:wa52/opencode-history-browser-next
```

Restart OpenCode once after installation. After that, running `opencode` with
no arguments opens the browser directly without showing the TUI loading page.

Use the browser's `Open CLI` button when you explicitly want the original
OpenCode command-line interface. Commands with arguments, such as
`opencode plugin ...` and `opencode --help`, continue to use the original
OpenCode executable.

The browser's `Open CLI` button opens the selected session as an independent
terminal client. Closing that terminal does not stop or reload the browser.
Browser replies always go through the OpenCode session API, so the browser does
not depend on the visible TUI input box to continue a chat.
The frontend is now split into small browser modules so the main page entry is
easier to maintain: `public/app.js`, `public/browser-dialogs.js`,
`public/browser-prompt.js`, and `public/browser-utils.js`.

On Windows, the plugin also creates `OpenCode Browser Next.vbs` on the desktop. Use
that shortcut afterward to start the browser UI without keeping an OpenCode
command window visible.

If it does not open, run this in OpenCode:

```text
/history-browser-next
```

To verify an install:

```text
/history-browser-next-doctor
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
- View richer Skill diagnostics with plugin and scope details
- View richer MCP diagnostics with connection status, command, cwd, source, and tool count
- Inline clickable paths in messages, Markdown, command output, and tool output
- Resolve relative paths from the current session workspace
- Support local drives, mapped drives, junctions, symlinks, and accessible UNC shares
- Open files with the system default app and folders in Explorer
- Browser commands: `/skills`, `/mcp`, `/logs`, and `/uninstall`
- Persistent diagnostics at `~/.config/opencode/history-browser-next.log`
- Install self-check with `/history-browser-next-doctor`
- Uninstall restores the original `opencode` command without removing OpenCode itself
- Split browser-side dialogs, prompt watcher, and utility rendering into dedicated modules

Closing the browser also stops the hidden OpenCode host after a short grace
period. Reloading the page does not stop it.

## Update

Windows:

```powershell
opencode.cmd plugin --global --force github:wa52/opencode-history-browser-next
```

macOS/Linux:

```sh
opencode plugin --global --force github:wa52/opencode-history-browser-next
```

Restart OpenCode after updating.

## Uninstall

Run this inside OpenCode:

```text
/history-browser-next-uninstall
```

Or use Browser settings > Uninstall, or type `/uninstall` in the browser input.
Then fully restart OpenCode. Uninstall only removes this plugin, the browser
launcher, and any redirect wrapper it installed; it does not remove or break
the original OpenCode executable.

## Requirements

- OpenCode installed
- No Python
- No manual database path
- No environment variables

## Troubleshooting

If `/history-browser-next` is missing after restart, run the update command above and restart OpenCode again.

On Windows, use `opencode.cmd` instead of `opencode` if PowerShell blocks `opencode.ps1`.

If the browser opens but history does not load, run `/history-browser-next-doctor` inside OpenCode.

Open Browser settings > Logs, or type `/logs`, to inspect startup, CLI, request,
and prompt errors. The log file is `~/.config/opencode/history-browser-next.log`.

The browser URL contains a temporary token. Reopen it with `/history-browser-next` instead of reusing an old URL.
