// Action: open the browser pane, optionally at the Ctrl-clicked URL.
import { spawnSync } from 'node:child_process';

const herdr = process.env.HERDR_BIN_PATH ?? 'herdr';
const url = process.env.HERDR_PLUGIN_CLICKED_URL;

const args = [
  'plugin', 'pane', 'open',
  '--plugin', process.env.HERDR_PLUGIN_ID ?? 'devtuns.browser',
  '--entrypoint', 'view',
  '--placement', 'split',
  '--direction', 'right',
];
if (process.env.HERDR_WORKSPACE_ID) args.push('--workspace', process.env.HERDR_WORKSPACE_ID);
if (url) args.push('--env', `HERDR_BROWSER_URL=${url}`);

const res = spawnSync(herdr, args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
