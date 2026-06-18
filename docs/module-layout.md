# Module Layout

This plugin is now split by function instead of keeping most server logic inside `tui.js`.

## Server-side modules

- `standalone.js`
  - starts the hidden OpenCode host
  - enforces single-instance browser startup
  - owns lifecycle cleanup for the background process tree

- `tui.js`
  - plugin entrypoint
  - browser HTTP route wiring
  - OpenCode command registration
  - launcher / redirect / uninstall orchestration

- `lib/opencode-session.js`
  - session list fallback
  - session detail shaping for the browser
  - explicit workspace-root binding for browser-created sessions
  - prompt sending
  - model / permission / question lookup
  - message activity normalization

- `lib/local-paths.js`
  - path extraction from chat text and tool output
  - local file / folder existence checks
  - open / reveal behavior across Windows, macOS, and Linux

- `lib/browser-snapshot.js`
  - Balanced snapshot assembly and output formatting

- `lib/snapshot-memory.js`
  - mixed compression extraction
  - recent-message tail
  - structured memory sections
  - source-index references

- `lib/browser-diagnostics.js`
  - Skills and MCP normalization for browser dialogs

- `lib/opencode-cli.js`
  - OpenCode executable discovery
  - terminal launch argument building

- `lib/redirect.js`
  - Windows command redirect ownership and backup forwarding

- `lib/process-tree.js`
  - background process cleanup

- `lib/cleanup.js`
  - idempotent cleanup wrapper

- `lib/write-queue.js`
  - serialized KV persistence

- `lib/static-files.js`
  - safe browser asset resolution inside `public/`

- `lib/identity.js`
  - plugin constants and filesystem identity

## Browser-side modules

- `public/app.js`
  - page state and main UI orchestration

- `public/browser-prompt.js`
  - prompt watcher and completion detection

- `public/browser-dialogs.js`
  - `/skills`, `/mcp`, `/logs`, `/uninstall` browser dialogs

- `public/browser-snapshot-view.js`
  - structured rendering for mixed snapshot sessions

- `public/browser-utils.js`
  - text cleanup, inline path rendering, clipboard image helpers

- `public/styles.css`
  - browser UI styling

## Current modularity goal

The current split makes `tui.js` the coordination layer, while business logic moves into dedicated service modules.

The next clean split, if we keep going, should be:

1. move HTTP route handlers into `lib/browser-routes.js`
2. move launcher / redirect / uninstall logic into `lib/browser-install.js`
3. split `public/app.js` into session pane, chat pane, and control pane modules
