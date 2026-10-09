# herdr-browser

A browser pane for [Herdr](https://github.com/ogulcancelik/herdr). See and click
through what your agents are building without leaving the terminal, in the
**same browser your agents drive**.

```
agent pane (workspace w8)                     browser pane (w8)
   └─ mcp.js → chrome-devtools-mcp ──┐   ┌── main.js (follows new tabs)
                                     ▼   ▼
                     headless Chrome for w8 (one per workspace)
                     stopped when the workspace closes
```

- **One headless Chrome per Herdr workspace.** Each project has its own cookies
  and logins.
- **The pane streams the page** as Kitty graphics and forwards your mouse and
  keyboard to it over the Chrome DevTools Protocol.
- **Agents attach to the same Chrome** through `chrome-devtools-mcp`, so you see
  every page they open and can take over at any time. When an agent opens a tab,
  the pane switches to it.

> Status: v0.1.0, early but usable. macOS and Linux.

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

Register the MCP launcher once. It picks the right Chrome from the agent pane's
`HERDR_WORKSPACE_ID`:

```sh
# Claude Code
claude mcp add --scope user herdr-browser -- \
  node ~/.local/state/herdr/plugins/devtuns.browser/current/src/mcp.js

# Antigravity CLI
agy mcp add herdr-browser "$(command -v node)" \
  ~/.local/state/herdr/plugins/devtuns.browser/current/src/mcp.js
```

Cursor: add this under `mcpServers` in `~/.cursor/mcp.json` (with your full
home path; Cursor doesn't expand `~`), then approve it once for the CLI with
`cursor-agent mcp enable herdr-browser`:

```json
"herdr-browser": {
  "command": "node",
  "args": ["/Users/you/.local/state/herdr/plugins/devtuns.browser/current/src/mcp.js"]
}
```

If the agent also has a standalone `chrome-devtools` MCP, it gets two sets of
identical browser tools and may pick the one that drives a separate, invisible
Chrome. Disable that one in Herdr workspaces, or tell the agent to use
`herdr-browser`.

`current` is a link that the plugin keeps pointed at its active installation
(Herdr installs each update into a new directory), so this survives
`herdr plugin update`. The link is created when the Herdr server starts or the
first time you open a browser pane. If `$XDG_STATE_HOME` is set, the path starts
there instead of `~/.local/state`.

Restart running agent sessions to pick it up. Any MCP-capable agent works the
same way: point its stdio MCP config at that `mcp.js`. Extra arguments are passed
through to `chrome-devtools-mcp`. Usage statistics and CrUX lookups are turned
off, so your local URLs aren't sent anywhere.

## Use

Open the browser pane:

```sh
herdr plugin pane open --plugin devtuns.browser --entrypoint view \
  --env HERDR_BROWSER_URL=http://localhost:3000
```

Or **Ctrl-click any `localhost` URL** in a Herdr pane. Without a URL it opens
`http://localhost:3000` (or whatever page the workspace's Chrome is already on).

| Key | Action |
|---|---|
| click / scroll / type | Sent to the page |
| `^L` or click the top bar | Edit the URL (`3000` → `http://localhost:3000`) |
| `^R` | Reload |
| `^S` | Cycle render mode: *auto* (default: half resolution while moving, full when still) → *sharp* (always full) → *fast* (always half) |
| `^Q` | Close the pane (Chrome keeps running for the workspace's agents) |

The status bar shows the URL and tab count. Run with `HERDR_BROWSER_DEBUG=1` to also
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
| `src/mcp.js` | Agent entrypoint: start/reuse that Chrome, then run `chrome-devtools-mcp --browserUrl` |
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
- If an agent resizes the page (`resize_page`), the pane resets it to fit itself.

## License

MIT. See [LICENSE](LICENSE).
