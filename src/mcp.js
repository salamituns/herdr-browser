#!/usr/bin/env node
// MCP entrypoint for agents, and a drop-in replacement for chrome-devtools-mcp:
//
// - In a Herdr pane (HERDR_WORKSPACE_ID is set, here or in an ancestor):
//   attach chrome-devtools-mcp to this workspace's Chrome (starting it if
//   needed), so the agent drives the browser the pane shows.
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
import { profileDir } from './paths.js';
import {
  lazyBrowserUrl, resolveHerdr, runMcp, withoutLaunchFlags,
} from './agent-mcp.js';

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

const userArgs = process.argv.slice(2);
const herdr = resolveHerdr();
const workspace = herdr?.workspace ?? null;
const inHerdr = Boolean(workspace);

let args = userArgs;
if (inHerdr) {
  args = [
    '--browserUrl', await lazyBrowserUrl(profileDir(workspace)),
    // These are local dev pages: don't send usage stats or URLs to Google.
    '--no-usage-statistics',
    '--no-performance-crux',
    ...withoutLaunchFlags(userArgs, LAUNCH_FLAGS, BOOLEAN_FLAGS),
  ];
}

runMcp('chrome-devtools-mcp@latest', args, { inHerdr, herdr });
