# herdr-browser: setup guide for AI agents

You are an AI agent setting up the herdr-browser Herdr plugin for a user. Follow
these steps in order. Each step has a check, so you can tell when it is done.

## What you are setting up

herdr-browser shows, in a Herdr pane, the Chrome that coding agents drive
through the Chrome DevTools MCP server (`chrome-devtools-mcp`). The user watches
the agent's browser live and can click and type into the same page.

The plugin ships a launcher, `src/mcp.js`, that replaces `chrome-devtools-mcp`
in agents' MCP configs:

- Inside a Herdr pane, it drives that workspace's Chrome, which the pane shows.
- Anywhere else (an IDE, a plain terminal, CI), it runs plain
  `npx -y chrome-devtools-mcp@latest` with the same arguments, unchanged.

So setup means installing the plugin and repointing the user's **existing**
`chrome-devtools` MCP entries at the launcher.

## Rules

- **Don't add a second browser MCP.** If an agent already has a
  `chrome-devtools` entry (whatever its name), replace that entry. Two entries
  give the agent two identical tool sets, and it may pick the one the user can't
  see.
- **Don't disable or remove the user's chrome-devtools setup** to make room for
  this one. The launcher already runs plain `chrome-devtools-mcp` outside Herdr.
- **Keep existing arguments** (`--headless`, `--isolated`, `--channel`, ...).
  They still apply outside Herdr.
- **Back up every config file before you edit it:**
  `cp <file> <file>.bak-herdr-browser`.
- **Only configure agents the user has installed.** Skip any agent whose CLI or
  config file isn't present.
- **Ask before restarting** the user's running agent sessions, including your
  own.
- At the end, tell the user what you changed and where the backups are.

## 1. Check requirements

```sh
herdr --version   # needs 0.9.0 or newer
node --version    # needs v22 or newer
echo "$HERDR_WORKSPACE_ID"   # non-empty means you are inside a Herdr pane
```

Chrome must be installed:

- macOS: `/Applications/Google Chrome.app` must exist.
- Linux: `command -v google-chrome` must print a path. If the user has Chromium
  or another Chrome build instead, it must be passed as `HERDR_BROWSER_CHROME`
  in the environment Herdr starts with. Tell the user; don't edit their shell
  profile on your own.

The user's terminal must support Kitty graphics: Ghostty (recommended), Kitty
or WezTerm. In Warp the pane flickers. If `$HERDR_WORKSPACE_ID` is empty, you
can still install and configure, but tell the user to open Herdr to use the
pane.

If a requirement is missing, stop and tell the user what to install.

## 2. Install the plugin

```sh
herdr plugin install salamituns/herdr-browser -y
herdr plugin list   # check: devtuns.browser is listed and enabled
```

If `devtuns.browser` is already listed, skip the install. To update a GitHub
install, run the same install command again.

## 3. Create the launcher path

Agents' configs point at a stable path that the plugin keeps aimed at its
current install:

```sh
LAUNCHER="${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/devtuns.browser/current/src/mcp.js"
ls -l "$LAUNCHER"
```

If the file doesn't exist yet, open a browser pane once. That creates the link,
and also shows the user the pane works. You must be inside a Herdr pane:

```sh
herdr plugin pane open --plugin devtuns.browser --entrypoint view \
  --env HERDR_BROWSER_URL=https://example.com
```

Check: `ls -l "$LAUNCHER"` succeeds. Ask the user whether they see example.com
in the new pane. If they see nothing or garbled text, their terminal doesn't
show Kitty graphics (see step 1).

In config files that don't expand `~` or `$HOME` (Cursor's JSON), write the
full absolute path, such as `/Users/name/.local/state/...`.

## 4. Point each agent's chrome-devtools entry at the launcher

Use `"$(command -v node)"` as the command where a full path is safer, since some
agents start MCP servers with a minimal `PATH`.

### Claude Code

```sh
claude mcp get chrome-devtools   # note the Scope and any Args
```

If it exists, remove it in the scope it was in (the output prints the exact
remove command), then add it back in the same scope with any extra arguments
appended after `mcp.js`:

```sh
claude mcp remove chrome-devtools -s user
claude mcp add --scope user chrome-devtools -- node "$LAUNCHER"
```

If it doesn't exist, add it with `--scope user`. Check: `claude mcp get
chrome-devtools` shows `Args: .../current/src/mcp.js`.

### Codex CLI

```sh
codex mcp get chrome-devtools
codex mcp remove chrome-devtools    # only if it exists
codex mcp add chrome-devtools -- "$(command -v node)" "$LAUNCHER"
```

Codex lists MCP tools as deferred (in `ALL_TOOLS`) and may claim browser tools
are unavailable without looking them up. Append this to `~/.codex/AGENTS.md`
(back it up first; create it if missing) unless an equivalent note is there:

```markdown
## Browser
For anything in a browser, use the `chrome-devtools` MCP tools. They may be
deferred, so look them up in ALL_TOOLS before saying they are unavailable.
```

If the user runs interactive Codex, its MCP servers live in a shared daemon.
After changing config, ask before running `codex app-server daemon restart`.

Check: `codex mcp get chrome-devtools` shows the launcher in `args`.

### Cursor (IDE and cursor-agent)

Edit `~/.cursor/mcp.json` (and `.cursor/mcp.json` in the project, if it has a
chrome-devtools entry). Find the entry whose args mention `chrome-devtools-mcp`,
whatever its key, and set its command and the launcher path, keeping extra
arguments after it:

```json
"chrome-devtools": {
  "command": "node",
  "args": ["/absolute/path/.local/state/herdr/plugins/devtuns.browser/current/src/mcp.js"]
}
```

If there is no entry, add this one under `mcpServers`. Validate the JSON after
editing (`node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))'
~/.cursor/mcp.json`). For the CLI, the user approves it once with
`cursor-agent mcp enable chrome-devtools`.

### Antigravity CLI

```sh
agy mcp list   # find the chrome-devtools entry's name, often chrome-devtools-mcp
agy mcp add <that-name> "$(command -v node)" "$LAUNCHER"   # add also updates
```

If there is no entry, use the name `chrome-devtools`.

### Any other MCP client

Find its stdio MCP config. Replace the command of its `chrome-devtools-mcp`
entry with `node <absolute path to the launcher>`, keeping extra arguments. If
it has none, add one.

## 5. Verify

Agents load MCP config at startup, so the change applies to new sessions. Ask
the user before restarting any.

In a new agent session inside a Herdr pane, ask the agent to open a page, for
example: "Use the chrome-devtools tools to open https://example.com". Check:

- The agent's tool call succeeds.
- A browser pane opens next to the agent's pane (unless its tab already had
  one) and shows the page.

If the tool call fails, look at
`${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/devtuns.browser/pane.log`
and run the launcher by hand to see its error: `node "$LAUNCHER" </dev/null`.

## Undo

Restore the `.bak-herdr-browser` backups, or point each entry back at
`npx -y chrome-devtools-mcp@latest`, then `herdr plugin uninstall
devtuns.browser`.

## Options the user may ask about

Set these in the MCP entry's environment (for example `claude mcp add -e`,
`codex mcp add --env`, or `"env"` in Cursor's JSON).

| Variable | Effect |
|---|---|
| `HERDR_BROWSER_AUTO_OPEN=0` | Don't open a pane on an agent's first browser call |
| `HERDR_BROWSER_MCP=standalone` | Use plain `chrome-devtools-mcp` even inside Herdr |
| `HERDR_BROWSER_CHROME=<path>` | Use a different Chrome binary |

More detail: https://github.com/salamituns/herdr-browser#readme
