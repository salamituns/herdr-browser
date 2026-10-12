#!/usr/bin/env node
// MCP entrypoint for agents, and a drop-in replacement for @playwright/mcp:
//
// - In a Herdr pane (HERDR_WORKSPACE_ID is set, here or in an ancestor):
//   attach @playwright/mcp to this workspace's Chrome (starting it if
//   needed), so the agent drives the browser the pane shows.
// - Anywhere else (an IDE, a plain terminal, CI): run plain @playwright/mcp
//   with the given args, exactly as if it had been configured directly.
//
// Point an existing playwright MCP entry at this file and keep its args:
//
//   claude mcp add --scope user playwright -- node /path/to/src/playwright-mcp.js
//
// Set HERDR_BROWSER_MCP=standalone to opt out inside Herdr.
import { profileDir } from './paths.js';
import {
  lazyBrowserUrl, resolveHerdr, runMcp, withoutLaunchFlags,
} from './agent-mcp.js';

// Flags that choose, launch, or isolate a browser. In Herdr the browser is
// the workspace's Chrome, passed as --cdp-endpoint, so these would fight that
// attach. Drop them; everything else (timeouts, origins, snapshots, …) is kept.
//
// --isolated is the important one for the pane: Playwright MCP then calls
// browser.newContext(), and that context's pages are not the default-context
// tabs the pane follows. Without it, connectOverCDP uses contexts()[0].
// --device / --mobile / --viewport-size are context options that only apply
// to a new context, so they would also hide the page (and fight the pane's
// viewport). --idle-timeout calls browser.close() and would take down the
// shared Chrome. --endpoint is Playwright's browser-server protocol, not CDP.
const LAUNCH_FLAGS = new Set([
  'browser', 'cdp-endpoint', 'cdp-header', 'executable-path',
  'headless', 'isolated', 'user-data-dir', 'extension', 'endpoint',
  'device', 'mobile', 'viewport-size', 'proxy-server', 'proxy-bypass',
  'storage-state', 'idle-timeout', 'no-sandbox', 'sandbox',
  'profile-dir-name',
]);
const BOOLEAN_FLAGS = new Set([
  'headless', 'isolated', 'extension', 'mobile', 'sandbox',
]);

const userArgs = process.argv.slice(2);
const herdr = resolveHerdr();
const workspace = herdr?.workspace ?? null;
const inHerdr = Boolean(workspace);

let args = userArgs;
if (inHerdr) {
  args = [
    '--cdp-endpoint', await lazyBrowserUrl(profileDir(workspace)),
    ...withoutLaunchFlags(userArgs, LAUNCH_FLAGS, BOOLEAN_FLAGS),
  ];
}

runMcp('@playwright/mcp@latest', args, { inHerdr, herdr });
