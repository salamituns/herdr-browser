#!/usr/bin/env node
// MCP entrypoint for agents, and a drop-in replacement for chrome-devtools-mcp:
//
// - In a Herdr pane (HERDR_WORKSPACE_ID is set): attach chrome-devtools-mcp to
//   this workspace's Chrome (starting it if needed), so the agent drives the
//   browser the pane shows.
// - Anywhere else (an IDE, a plain terminal, CI): run plain chrome-devtools-mcp
//   with the given args, exactly as if it had been configured directly.
//
// So an agent needs only one browser MCP, and never sees two identical tool
// sets it could pick the wrong one from. Point an existing chrome-devtools entry
// at this file and keep its args:
//
//   claude mcp add --scope user chrome-devtools -- node /path/to/src/mcp.js
//
// Set HERDR_BROWSER_MCP=standalone to opt out inside Herdr.
import { spawn } from 'node:child_process';
import { ensureChrome } from './chrome.js';
import { profileDir } from './paths.js';

const userArgs = process.argv.slice(2);
const inHerdr = Boolean(process.env.HERDR_WORKSPACE_ID)
  && process.env.HERDR_BROWSER_MCP !== 'standalone';

// Flags that choose or launch a browser. In Herdr the browser is the
// workspace's, so these would conflict with --browserUrl; drop them.
const LAUNCH_FLAGS = new Set([
  'browserUrl', 'browser-url', 'u', 'wsEndpoint', 'ws-endpoint', 'w',
  'wsHeaders', 'ws-headers', 'autoConnect', 'auto-connect', 'headless',
  'isolated', 'userDataDir', 'user-data-dir', 'channel', 'executablePath',
  'executable-path', 'e', 'chromeArg', 'chrome-arg', 'ignoreDefaultChromeArg',
  'ignore-default-chrome-arg', 'viewport', 'proxyServer', 'proxy-server',
]);
const BOOLEAN_FLAGS = new Set(['autoConnect', 'auto-connect', 'headless', 'isolated']);

function withoutLaunchFlags(args) {
  const kept = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^--?(?:no-)?([^=]+)(=.*)?$/.exec(args[i]);
    if (!m || !LAUNCH_FLAGS.has(m[1])) { kept.push(args[i]); continue; }
    if (m[2] !== undefined) continue; // --flag=value
    const next = args[i + 1];
    const takesValue = BOOLEAN_FLAGS.has(m[1]) ? next === 'true' || next === 'false' : next !== undefined && !next.startsWith('-');
    if (takesValue) i++;
  }
  return kept;
}

let args = userArgs;
if (inHerdr) {
  const { port } = await ensureChrome(profileDir());
  args = [
    '--browserUrl', `http://127.0.0.1:${port}`,
    // These are local dev pages: don't send usage stats or URLs to Google.
    '--no-usage-statistics',
    '--no-performance-crux',
    ...withoutLaunchFlags(userArgs),
  ];
}

// stdout is the MCP stdio channel: nothing else may be written to it.
const child = spawn('npx', ['-y', 'chrome-devtools-mcp@latest', ...args], { stdio: 'inherit' });

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
