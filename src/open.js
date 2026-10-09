// Action: open the browser pane, optionally at the Ctrl-clicked URL.
// If the workspace already shows a browser pane, open the URL as a new tab in
// its Chrome instead: the pane follows new tabs, so no second pane piles up.
import { spawnSync } from 'node:child_process';
import { livePort } from './chrome.js';
import { profileDir } from './paths.js';

const herdr = process.env.HERDR_BIN_PATH ?? 'herdr';
const url = process.env.HERDR_PLUGIN_CLICKED_URL;
const workspace = process.env.HERDR_WORKSPACE_ID;

function browserPaneOpen() {
  if (!workspace) return false;
  const res = spawnSync(herdr, ['pane', 'list', '--workspace', workspace], { encoding: 'utf8' });
  try {
    return JSON.parse(res.stdout).result.panes.some((p) => p.label === 'Browser');
  } catch {
    return false;
  }
}

if (url && browserPaneOpen()) {
  const port = await livePort(profileDir());
  if (port) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: 'PUT' })
      .catch(() => null);
    if (res?.ok) process.exit(0);
  }
}

// Split placement must target a pane (Herdr rejects --workspace with split),
// so split next to the pane that was focused when the action ran.
const args = [
  'plugin', 'pane', 'open',
  '--plugin', process.env.HERDR_PLUGIN_ID ?? 'devtuns.browser',
  '--entrypoint', 'view',
  '--placement', 'split',
  '--direction', 'right',
];
if (process.env.HERDR_PANE_ID) args.push('--target-pane', process.env.HERDR_PANE_ID);
if (url) args.push('--env', `HERDR_BROWSER_URL=${url}`);

const res = spawnSync(herdr, args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
