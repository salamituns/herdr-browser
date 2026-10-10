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
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ensureChrome } from './chrome.js';
import { profileDir } from './paths.js';

const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';

function processInfo(pid) {
  if (process.platform === 'linux') {
    return {
      env: readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'),
      ppid: Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]),
      name: readFileSync(`/proc/${pid}/comm`, 'utf8').trim(),
    };
  }
  // macOS: `ps -E` appends the environment to the command line. It shows
  // nothing for SIP-protected binaries (/bin/sh, /bin/bash), which is fine:
  // the agent process above them is what carries the variable.
  const ps = (...args) => execFileSync('ps', [...args, '-p', String(pid)], { encoding: 'utf8' }).trim();
  return {
    env: ps('-E', '-ww', '-o', 'command=').split(' '),
    ppid: Number(ps('-o', 'ppid=')),
    name: ps('-o', 'comm=').split('/').pop(),
  };
}

// Some agents (cursor-agent) start MCP servers with a scrubbed environment, so
// HERDR_WORKSPACE_ID may be missing even inside a Herdr pane. The agent process
// itself still has it: take it from the nearest ancestor that does. Only trust
// it if the chain leads to the Herdr server, though. Codex runs MCP servers from
// a shared daemon that outlives the pane it started in (it ends up under
// launchd), so its environment names whichever workspace launched it first.
function ancestorWorkspace() {
  let found = null;
  let pid = process.ppid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    try {
      const { env, ppid, name } = processInfo(pid);
      if (name === 'herdr') return found;
      const hit = env.find((kv) => kv.startsWith('HERDR_WORKSPACE_ID='));
      found ??= hit ? hit.slice('HERDR_WORKSPACE_ID='.length).trim() : null;
      pid = ppid;
    } catch {
      return null;
    }
  }
  return null;
}

// Last resort (the Codex daemon case): the agent starts us in its session's
// directory, so find the Herdr workspace with an agent pane in that directory.
function cwdWorkspace() {
  let panes;
  try {
    panes = JSON.parse(execFileSync(herdrBin, ['pane', 'list'], { encoding: 'utf8', timeout: 3000 })).result.panes;
  } catch {
    return null; // Herdr isn't running or isn't installed: not in Herdr
  }
  const cwd = process.cwd();
  // Only agent panes count, so a plain shell in the same directory doesn't pull
  // an agent running outside Herdr in. Several workspaces on one directory is
  // ambiguous: prefer the focused pane's, then the first.
  const agents = panes.filter((p) => p.agent && (p.cwd === cwd || p.foreground_cwd === cwd));
  return (agents.find((p) => p.focused) ?? agents[0])?.workspace_id ?? null;
}

const userArgs = process.argv.slice(2);
const workspace = process.env.HERDR_BROWSER_MCP === 'standalone' ? null
  : process.env.HERDR_WORKSPACE_ID || ancestorWorkspace() || cwdWorkspace();
const inHerdr = Boolean(workspace);

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
  const { port } = await ensureChrome(profileDir(workspace));
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
