#!/usr/bin/env node
// MCP entrypoint for agents: attach chrome-devtools-mcp to this workspace's
// Chrome (starting it if needed), so the agent drives the browser the pane shows.
//
//   claude mcp add --scope user herdr-browser -- node /path/to/src/mcp.js
//
// Extra args are passed through to chrome-devtools-mcp.
import { spawn } from 'node:child_process';
import { ensureChrome } from './chrome.js';
import { profileDir } from './paths.js';

const { port } = await ensureChrome(profileDir());

// stdout is the MCP stdio channel: nothing else may be written to it.
const child = spawn('npx', [
  '-y', 'chrome-devtools-mcp@latest',
  '--browserUrl', `http://127.0.0.1:${port}`,
  // These are local dev pages: don't send usage stats or URLs to Google.
  '--no-usage-statistics',
  '--no-performance-crux',
  ...process.argv.slice(2),
], { stdio: 'inherit' });

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
