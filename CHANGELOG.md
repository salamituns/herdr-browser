# Changelog

## Unreleased

**Pane**
- Scrolling no longer bounces at the top or bottom of a page on macOS. Chrome
  rubber-banded the page on every wheel burst past the edge (trackpad
  momentum), about 75 frames of the page jumping and springing back. The pane
  now sets `overscroll-behavior: none` on the shown tab's root through a
  constructed stylesheet: no DOM node for agents' snapshots, and zero
  specificity so a page's own setting still wins.

## 0.3.0 (2026-10-12)

Playwright MCP shows up in the pane too, and Droid is supported.

**Agents**
- `src/playwright-mcp.js` is a drop-in for `@playwright/mcp`, the same way
  `src/mcp.js` wraps `chrome-devtools-mcp`. Inside Herdr it attaches to the
  workspace's Chrome with `--cdp-endpoint` and drops `--isolated` and other
  flags that would launch or hide a different browser; outside Herdr it runs
  plain `@playwright/mcp`. Shared launcher code lives in `src/agent-mcp.js`.
- Droid (Factory): point the `chrome-devtools` and `playwright` entries in
  `~/.factory/mcp.json` at the launchers.

**Setup**
- `agent-guide.md`: steps an AI agent can follow to install the plugin and
  repoint the user's existing chrome-devtools and Playwright entries, with a
  check for each step. It keeps Codex's per-tool approval settings, which
  `codex mcp remove` would delete.
- README paste-in prompt that has your agent follow the guide.
- `llms.txt` for agents and search tools.
- README leads with what the plugin is for: watching the browser your agents
  already drive.

## 0.2.0 (2026-10-10)

Agents and the pane now share one browser out of the box, in Claude Code,
Cursor, Codex and Antigravity.

**Agents**
- `src/mcp.js` is a drop-in replacement for `chrome-devtools-mcp`: point your
  existing `chrome-devtools` MCP entry at it. Inside a Herdr pane it drives the
  workspace's visible Chrome; anywhere else it runs plain `chrome-devtools-mcp`
  with your arguments, so agents never see two identical browser tool sets.
- Finds the agent's workspace even when the agent hides it: Cursor starts MCP
  servers with a scrubbed environment, and interactive Codex runs them from a
  shared daemon that outlives its pane.
- The first browser tool call opens a browser pane next to the agent, unless
  its tab already has one (`HERDR_BROWSER_AUTO_OPEN=0` to turn off). That pane
  only watches: it never navigates the agent's tab.
- Chrome starts on the first browser tool call instead of when the agent
  starts, so agents that never browse never start a Chrome.

**Pane**
- Device emulation by an agent (say a 390px phone) is shown at its real
  proportions, centered, with the size in the status bar, and clicks map
  correctly.
- Several panes on one workspace share the viewport: focusing a pane takes it
  back from another pane, never from an agent's device emulation.
- Uncaught errors are logged to `pane.log` instead of closing the pane.
- Adaptive resolution (half resolution while scrolling, full when still) and
  frames sent by temp file instead of base64 through the PTY.
- Fixed: Ctrl-clicking a localhost link didn't open the pane.

## 0.1.0 (2026-10-09)

First release: a Herdr pane that streams the workspace's headless Chrome as
Kitty graphics, with mouse, keyboard and scrolling sent back over CDP.
