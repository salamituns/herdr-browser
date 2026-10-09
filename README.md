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

> Status: working prototype (v0.0.1). macOS and Linux.

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
git clone <this repo> ~/devtuns/herdr-browser
herdr plugin link ~/devtuns/herdr-browser
```

Check that your terminal can show images:

```sh
herdr plugin pane open --plugin devtuns.browser --entrypoint probe
```

If you see a red/green gradient, it works.

### Connect your agents

Register the MCP launcher once. It picks the right Chrome from the agent pane's
`HERDR_WORKSPACE_ID`:

```sh
claude mcp add --scope user herdr-browser -- node ~/devtuns/herdr-browser/src/mcp.js
```

Restart running agent sessions to pick it up. Any MCP-capable agent works the
same way: point its stdio MCP config at `node src/mcp.js`. Extra arguments are
passed through to `chrome-devtools-mcp`. Usage statistics and CrUX lookups are
turned off, so your local URLs aren't sent anywhere.

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
| `^S` | Toggle *sharp* (pixel-exact) / *fast* (half resolution, ~4× less data) |
| `^Q` | Close the pane (Chrome keeps running for the workspace's agents) |

The status bar shows the frame rate, throughput, render mode, cell size, tab count
and the CDP port.

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
| `src/paths.js` | Shared state paths (`~/.local/state/herdr/plugins/devtuns.browser`) |
| `src/cdp.js` | Minimal CDP client over Node's built-in WebSocket |
| `src/probe.js` | Kitty graphics capability check |

Design notes:

- **Pixel-exact rendering.** The image is sized to the pane's real pixels, using
  the cell size from `CSI 16 t` and in-band resize reports (DECSET 2048). Chrome's
  device scale factor keeps CSS cells about 8px wide. Ghostty reports physical
  pixels and Warp logical ones; both are handled.
- **Latest frame wins.** If the terminal falls behind, intermediate frames are
  dropped rather than queued, so what you see never lags behind the page.
- **Double buffering.** Frames alternate between two Kitty image ids and the new
  one is placed before the old one is deleted, so there's never an empty pane.
- **Wheel decoding.** Trackpads mix horizontal ticks into vertical swipes. Ticks
  are decoded by direction and coalesced to one event per frame.

## Known limits

- About 15 fps while scrolling at Retina sharpness. Every change, even a blinking
  text cursor, sends a full PNG frame.
- An agent pane moved to another workspace keeps using its original workspace's
  browser, because the MCP server reads `HERDR_WORKSPACE_ID` at startup.
- If an agent resizes the page (`resize_page`), the pane resets it to fit itself.
