# herdr-browser

**Watch your coding agents use the browser, inside
[Herdr](https://github.com/herdrdev/herdr).**

Claude Code, Codex, Cursor and Antigravity drive Chrome through
`chrome-devtools-mcp` or `@playwright/mcp`, but that Chrome is usually
invisible. This plugin shows it in a Herdr pane next to the agent, live, and
lets you click and type into the same page. Your agents keep the browser tools
they already use: nothing new to install in the agent, nothing new for it to
learn.

```
agent pane (workspace w8)                     browser pane (w8)
   └─ mcp.js / playwright-mcp.js ────┐   ┌── main.js (follows new tabs)
                                     ▼   ▼
                     headless Chrome for w8 (one per workspace)
                     started on first use, stopped when the workspace closes
```

- **A drop-in for `chrome-devtools-mcp` and `@playwright/mcp`.** Point your
  existing MCP entry at the matching plugin launcher (`src/mcp.js` or
  `src/playwright-mcp.js`). Inside Herdr it drives the workspace's visible
  Chrome; anywhere else it runs the plain MCP server, unchanged.
- **The pane opens itself** next to the agent the first time it uses a browser
  tool, and switches to each tab the agent opens.
- **One Chrome per Herdr workspace,** with its own cookies and logins, started
  on the first browser call.
- **Take over at any time:** mouse, keyboard, scrolling and the URL bar go to
  the same page. Phone emulation by the agent is shown at its real proportions.

> v0.2.0, macOS and Linux. Looking for a general-purpose browser in the
> terminal instead? See [Related projects](#related-projects).

## Let your agent set it up

In an agent running inside a Herdr pane, paste:

```
Set up the herdr-browser Herdr plugin for me by following
https://raw.githubusercontent.com/salamituns/herdr-browser/main/agent-guide.md
```

[`agent-guide.md`](agent-guide.md) has the agent check the requirements,
install the plugin, repoint your existing `chrome-devtools` entries (backing up
each config file first) and verify that a pane opens. It asks before restarting
agent sessions. To do it by hand, read on.

## Requirements

- Herdr ≥ 0.9.0
- Node.js ≥ 22
- Google Chrome. Set `HERDR_BROWSER_CHROME` to use a different binary.
- An outer terminal with full Kitty graphics support: **Ghostty** (recommended),
  Kitty or WezTerm.

> **Warp:** the image displays, but it flickers constantly. Herdr re-sends image
> placements on every UI redraw, and Warp repaints the image each time. Ghostty
> and Kitty don't. Run Herdr in Ghostty for this workflow. Your sessions persist,
> so you can attach the same session from both terminals.

## Install

```sh
herdr plugin install salamituns/herdr-browser
```

There's no build step. To hack on it, clone the repo and run
`herdr plugin link <path>` instead.

Check that your terminal can show images:

```sh
herdr plugin pane open --plugin devtuns.browser --entrypoint probe
```

If you see a red/green gradient, it works.

### Connect your agents

Each launcher is a drop-in replacement for the MCP server it wraps. Inside a
Herdr pane (`HERDR_WORKSPACE_ID` is set) it attaches to that workspace's
visible Chrome; anywhere else (an IDE, a plain terminal, CI) it runs the plain
server with your arguments, unchanged. Replace your existing entry rather than
adding a second browser MCP: one tool set, and the agent can't pick the
invisible browser by mistake.

#### chrome-devtools-mcp (`src/mcp.js`)

```sh
# Claude Code
claude mcp add --scope user chrome-devtools -- \
  node ~/.local/state/herdr/plugins/devtuns.browser/current/src/mcp.js

# Antigravity CLI (re-adding an existing name updates it)
agy mcp add chrome-devtools-mcp "$(command -v node)" \
  ~/.local/state/herdr/plugins/devtuns.browser/current/src/mcp.js

# Codex CLI
codex mcp add chrome-devtools -- "$(command -v node)" \
  ~/.local/state/herdr/plugins/devtuns.browser/current/src/mcp.js
```

Codex lists MCP tools as deferred (in `ALL_TOOLS`) rather than up front, and
may answer that the browser tools are unavailable without looking. A line in
`~/.codex/AGENTS.md` fixes that, for example: "For anything in a browser, use
the `chrome-devtools` MCP tools; they may be deferred, so look them up in
ALL_TOOLS."

Cursor: set your `chrome-devtools` entry in `~/.cursor/mcp.json` to this (use
the full path), then approve it once for the CLI with
`cursor-agent mcp enable chrome-devtools`:

```json
"chrome-devtools": {
  "command": "node",
  "args": ["/Users/you/.local/state/herdr/plugins/devtuns.browser/current/src/mcp.js"]
}
```

Droid: set the `chrome-devtools` entry in `~/.factory/mcp.json` the same way
(full paths for both `node` and `mcp.js`).

Keep any arguments you had (`--headless`, `--isolated`, `--channel`, ...).
They apply outside Herdr; inside Herdr, flags that choose or launch a browser
are dropped because the workspace's browser is used. To force the standalone
behavior inside Herdr, set `HERDR_BROWSER_MCP=standalone`. If you uninstall the
plugin, point the entry back at `npx -y chrome-devtools-mcp@latest`.

#### @playwright/mcp (`src/playwright-mcp.js`)

Same idea, different file. Point an existing `playwright` entry at
`.../current/src/playwright-mcp.js` instead of `npx @playwright/mcp@latest`.
Inside Herdr the launcher passes `--cdp-endpoint` to the workspace Chrome and
drops flags that would launch or isolate a different browser (`--browser`,
`--isolated`, `--headless`, `--user-data-dir`, `--extension`, `--device`, …).
`--isolated` in particular would open a new browser context the pane does not
follow. Keep those flags for when the same entry runs outside Herdr.

```sh
claude mcp add --scope user playwright -- \
  node ~/.local/state/herdr/plugins/devtuns.browser/current/src/playwright-mcp.js
```

Cursor:

```json
"playwright": {
  "command": "node",
  "args": ["/Users/you/.local/state/herdr/plugins/devtuns.browser/current/src/playwright-mcp.js"]
}
```

`current` is a link that the plugin keeps pointed at its active installation
(Herdr installs each update into a new directory), so this survives
`herdr plugin update`. The link is created when the Herdr server starts or the
first time you open a browser pane. If `$XDG_STATE_HOME` is set, the path starts
there instead of `~/.local/state`.

Restart running agent sessions to pick it up. Any MCP-capable agent works the
same way: point its stdio MCP config at that `mcp.js`. Inside Herdr, usage
statistics and CrUX lookups are turned off, so your local URLs aren't sent
anywhere.

## Use

Open the browser pane:

```sh
herdr plugin pane open --plugin devtuns.browser --entrypoint view \
  --env HERDR_BROWSER_URL=http://localhost:3000
```

You usually don't have to: **the first time an agent uses a browser tool, a
browser pane opens next to the agent's pane** (unless that tab already has
one), so you can watch it work. `HERDR_BROWSER_AUTO_OPEN=0` turns this off.

Or **Ctrl-click any `localhost` URL** in a Herdr pane. Without a URL it opens
`http://localhost:3000` (or whatever page the workspace's Chrome is already on).

| Key | Action |
|---|---|
| click / scroll / type | Sent to the page |
| `^L` or click the top bar | Edit the URL (`3000` → `http://localhost:3000`) |
| `^R` | Reload |
| `^S` | Cycle render mode: *auto* (default: half resolution while moving, full when still) → *sharp* (always full) → *fast* (always half) |
| `^Q` | Close the pane (Chrome keeps running for the workspace's agents) |

The status bar shows the URL and tab count. When an agent emulates a device
(say a 390×844 phone), the page is shown at those proportions, centered, and the
status bar shows the size. Run with `HERDR_BROWSER_DEBUG=1` to also
show the frame rate, throughput, render mode, cell size and CDP port.

Plugin actions: `devtuns.browser.open`, `devtuns.browser.stop` (stops the
workspace's Chrome). Chrome also stops automatically on `workspace.closed`.

## How it works

| File | Role |
|---|---|
| `herdr-plugin.toml` | Panes, actions, the localhost link handler and the `workspace.closed` hook |
| `src/main.js` | The pane: screencast → Kitty graphics, input → CDP, tab following, layout |
| `src/input.js` | SGR mouse parsing, cell → page coordinates, wheel decoding and coalescing, keys |
| `src/kitty.js` | Kitty graphics encoding (chunked PNG, double-buffered image ids) |
| `src/chrome.js` | Start or reuse the workspace's detached headless Chrome |
| `src/agent-mcp.js` | Shared launcher: workspace resolution, lazy CDP proxy, pane auto-open, stdio forwarding |
| `src/mcp.js` | Agent entrypoint and drop-in for `chrome-devtools-mcp`: attach to the workspace Chrome, open a pane on the first tool call |
| `src/playwright-mcp.js` | Same drop-in for `@playwright/mcp`, attaching with `--cdp-endpoint` |
| `src/stop.js` | Stop a workspace's Chrome (event hook and action) |
| `src/paths.js` | Shared state paths (`~/.local/state/herdr/plugins/devtuns.browser`) and the `current` install link |
| `src/startup.js` | Startup hook: refresh the `current` link |
| `src/cdp.js` | Minimal CDP client over Node's built-in WebSocket |
| `src/probe.js` | Kitty graphics capability check |

Design notes:

- **Pixel-exact rendering.** The image is sized to the pane's real pixels, using
  the cell size from `CSI 16 t` and in-band resize reports (DECSET 2048). Chrome's
  device scale factor keeps CSS cells about 8px wide. Ghostty reports physical
  pixels and Warp logical ones; both are handled.
  Chrome is launched with `--force-device-scale-factor=2`, because headless
  capture ignores the emulated scale factor and would otherwise send 1× frames
  that the terminal enlarges (blurry). `HERDR_BROWSER_DEBUG=1` shows `frame:`
  (actual) next to `want:` (pane pixels), so a mismatch is easy to spot.
- **Adaptive resolution.** At full Retina size, Chrome's PNG encoding is the
  bottleneck (about 15–19 fps), not the terminal. In *auto* mode the pane streams
  at half resolution while the page moves (about 26–29 fps) and replaces it with
  one full-resolution capture once the page has been still for 150 ms.
- **Frames go by file, not through the PTY.** Each frame is written to a temp
  file and sent as a Kitty `t=t` path (about 60 bytes instead of about 1 MB of
  base64). Herdr reads the file and deletes it. A startup probe falls back to
  inline base64 if the terminal refuses (`HERDR_BROWSER_TRANSPORT=inline|file`
  forces one).
- **Latest frame wins.** If the terminal falls behind, intermediate frames are
  dropped rather than queued, so what you see never lags behind the page.
- **Double buffering.** Frames alternate between two Kitty image ids and the new
  one is placed before the old one is deleted, so there's never an empty pane.
- **One tab, several panes.** Every browser pane in a workspace shows the same
  Chrome tab, and the viewport follows whichever pane set it last. A pane takes
  it back when you focus it, but only from another pane (they record what they
  set), never from an agent that is emulating a device.
- **Chrome starts on first use.** Every agent session starts its MCP server,
  but `chrome-devtools-mcp` only contacts the browser on its first tool call, so
  the launcher hands it a local proxy address that starts the workspace's Chrome
  on that first request. Agents that never browse never start a Chrome. A lock
  in the profile keeps the pane and an agent from launching two at once.
- **Errors don't close the pane.** Uncaught errors go to
  `~/.local/state/herdr/plugins/devtuns.browser/pane.log` and the pane keeps
  running.
- **Wheel decoding.** Trackpads mix horizontal ticks into vertical swipes. Ticks
  are decoded by direction and coalesced to one event per frame.

## Known limits

- Every change, even a blinking text cursor, still sends a whole frame (no
  partial updates yet).
- If one Herdr session is attached from two terminals (say Warp and Ghostty), the
  cell size follows the one you last typed in, and the pane renders for that
  terminal. Detach the one you're not using.
- An agent pane moved to another workspace keeps using its original workspace's
  browser, because the MCP server reads `HERDR_WORKSPACE_ID` at startup.
- Resizing the pane (or switching render mode) resets an agent's emulated
  viewport to the pane's size.
- Interactive Codex starts MCP servers from a shared daemon, so the launcher
  finds the agent's workspace by its working directory. Two Codex sessions in
  one directory are told apart by which one is working when the first browser
  call comes in.

## Related projects

- [zenbu-labs/terminal-browser](https://github.com/zenbu-labs/terminal-browser):
  a full browser inside your terminal. Pick it if you want to browse yourself.
- [StructuPath/herdr-browser](https://github.com/StructuPath/herdr-browser): a
  Herdr pane for [agent-browser](https://github.com/vercel-labs/agent-browser)
  sessions. Pick it if your agents use agent-browser rather than
  `chrome-devtools-mcp`.

## License

MIT. See [LICENSE](LICENSE).
