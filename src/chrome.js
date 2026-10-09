// One headless Chrome per Herdr workspace, keyed by its profile directory.
// If it's already running (opened by an earlier pane, or for an agent), reuse it,
// so the human and the agents always look at the same browser.
// Chrome is detached: it outlives whichever pane or agent started it, and is
// stopped by the workspace.closed hook (src/stop.js).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.HERDR_BROWSER_CHROME
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome writes its chosen port to <profile>/DevToolsActivePort. The file can be
// stale after a crash, so only trust it if the port answers.
export async function livePort(profileDir) {
  const file = join(profileDir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    return res.ok ? port : null;
  } catch {
    return null;
  }
}

export async function ensureChrome(profileDir) {
  mkdirSync(profileDir, { recursive: true });
  const running = await livePort(profileDir);
  if (running) return { port: running };

  const child = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    // Headless capture ignores Emulation's deviceScaleFactor: without this,
    // frames are 1x even when the page reports devicePixelRatio=2, and the
    // terminal upscales them (blurry). The pane picks the final resolution via
    // the screencast's maxWidth/maxHeight, so 2x is the ceiling, not a fixed size.
    `--force-device-scale-factor=${process.env.HERDR_BROWSER_DEVICE_SCALE ?? 2}`,
    'about:blank',
  ], { stdio: 'ignore', detached: true });
  child.unref();

  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const port = await livePort(profileDir);
    if (port) return { port };
    if (child.exitCode !== null) break;
  }
  child.kill();
  throw new Error(`Chrome did not start (${CHROME})`);
}

export async function pageWsUrl(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let page = list.find((t) => t.type === 'page');
  if (!page) {
    page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  }
  return page.webSocketDebuggerUrl;
}
