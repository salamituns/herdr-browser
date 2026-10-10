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
      const get = (key) => env.find((kv) => kv.startsWith(`${key}=`))?.slice(key.length + 1).trim();
      const workspace = get('HERDR_WORKSPACE_ID');
      if (workspace) found ??= { workspace, pane: get('HERDR_PANE_ID') ?? null };
      pid = ppid;
    } catch {
      return null;
    }
  }
  return null;
}

function herdrPanes(...args) {
  try {
    return JSON.parse(execFileSync(herdrBin, ['pane', 'list', ...args], { encoding: 'utf8', timeout: 3000 })).result.panes;
  } catch {
    return null; // Herdr isn't running or isn't installed
  }
}

// Last resort (the Codex daemon case): the agent starts us in its session's
// directory, so find an agent pane in that directory. Only agent panes count,
// so a plain shell in the same directory doesn't pull an agent running outside
// Herdr in. Several agents in one directory is ambiguous: the one that is
// working is the one calling us, then the focused one, then the first.
function cwdAgentPane(workspace) {
  const cwd = process.cwd();
  const agents = (herdrPanes(...(workspace ? ['--workspace', workspace] : [])) ?? [])
    .filter((p) => p.agent && (p.cwd === cwd || p.foreground_cwd === cwd));
  const pane = agents.find((p) => p.agent_status === 'working') ?? agents.find((p) => p.focused) ?? agents[0];
  return pane ? { workspace: pane.workspace_id, pane: pane.pane_id, fromCwd: true } : null;
}

function resolveHerdr() {
  if (process.env.HERDR_BROWSER_MCP === 'standalone') return null;
  if (process.env.HERDR_WORKSPACE_ID) {
    return { workspace: process.env.HERDR_WORKSPACE_ID, pane: process.env.HERDR_PANE_ID ?? null };
  }
  return ancestorWorkspace() ?? cwdAgentPane();
}

const userArgs = process.argv.slice(2);
const herdr = resolveHerdr();
const workspace = herdr?.workspace ?? null;
const inHerdr = Boolean(workspace);

// Show the agent's work: on its first browser tool call, open a browser pane
// next to the agent's pane, unless its tab already has one.
// HERDR_BROWSER_AUTO_OPEN=0 turns this off.
function openPaneForAgent() {
  if (process.env.HERDR_BROWSER_AUTO_OPEN === '0') return;
  // Re-resolve the pane by cwd now: at call time the caller is the working agent.
  const pane = herdr.fromCwd ? (cwdAgentPane(workspace)?.pane ?? herdr.pane) : herdr.pane;
  if (!pane) return;
  const panes = herdrPanes('--workspace', workspace);
  const tab = panes?.find((p) => p.pane_id === pane)?.tab_id;
  if (!tab || panes.some((p) => p.tab_id === tab && p.label === 'Browser')) return;
  const open = spawn(herdrBin, [
    'plugin', 'pane', 'open', '--plugin', 'devtuns.browser', '--entrypoint', 'view',
    '--placement', 'split', '--target-pane', pane, '--direction', 'right', '--no-focus',
  ], { stdio: 'ignore' });
  open.on('error', () => {});
}

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

// stdout is the MCP stdio channel: nothing else may be written to it. In
// Herdr, requests pass through us unchanged so we can spot the first tool call.
const child = spawn('npx', ['-y', 'chrome-devtools-mcp@latest', ...args], {
  stdio: [inHerdr ? 'pipe' : 'inherit', 'inherit', 'inherit'],
});
if (inHerdr) {
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {}); // child gone: its exit handler ends us
  let pending = '';
  const watch = (chunk) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.includes('"tools/call"')) {
        process.stdin.off('data', watch);
        pending = '';
        try { openPaneForAgent(); } catch {}
        return;
      }
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', watch);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
