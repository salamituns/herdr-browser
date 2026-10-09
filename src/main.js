// Browser pane: stream the workspace's headless Chrome into this pane as
// Kitty graphics, and forward mouse/keyboard back to it over CDP.
// The pane follows tabs: when an agent opens a tab, the pane switches to it.
import { connectCDP } from './cdp.js';
import { ensureChrome } from './chrome.js';
import { kittyPng, kittyDelete, kittyDeleteAll } from './kitty.js';
import { dispatchKeys, dispatchMouse, parseMouse, stripMouse } from './input.js';
import { profileDir } from './paths.js';

const out = process.stdout;
// Double buffering: alternate two image ids and place the new frame over the
// old one before deleting it. Replacing a single id makes Herdr delete the old
// image first, leaving a blank gap the outer terminal can paint (flicker).
const IMAGE_IDS = [4242, 4243];
let front = 0;
const TOP_ROWS = 1;

// Ask the terminal for its cell size in pixels: CSI 16 t -> CSI 6 ; h ; w t.
// Herdr answers, but the round trip through the outer terminal can take >300ms.
function queryCellSize() {
  return new Promise((resolve) => {
    let seen = '';
    const fallback = setTimeout(() => { process.stdin.off('data', onData); resolve(null); }, 1500);
    function onData(buf) {
      seen += buf.toString();
      const m = seen.match(/\x1b\[6;(\d+);(\d+)t/);
      if (!m) return;
      clearTimeout(fallback);
      process.stdin.off('data', onData);
      resolve({ w: Number(m[2]), h: Number(m[1]) });
    }
    process.stdin.on('data', onData);
    out.write('\x1b[16t');
  });
}

// Sharpness: the image must have exactly as many pixels as the terminal draws
// for the pane, or it gets resampled (blurry). Terminals disagree on units:
// Ghostty reports physical pixels (16x34 on Retina), Warp logical ones (8x16).
// So size the image from the reported cells, and pick the device scale factor
// that keeps CSS cells ~8px wide (normal page zoom). ^S trades sharpness for
// speed by rendering at half that.
const CSS_CELL_WIDTH = 8;
let cell = { w: 8, h: 17 };
let cellSource = 'fallback';
let fast = process.env.HERDR_BROWSER_FAST === '1';
let scale = 1; // Chrome deviceScaleFactor, derived in computeLayout
let layout;
function computeLayout() {
  const cols = out.columns;
  const rows = Math.max(1, out.rows - TOP_ROWS);
  const density = Math.max(1, Math.round(cell.w / CSS_CELL_WIDTH));
  scale = fast ? Math.max(1, density / 2) : density;
  layout = {
    topRows: TOP_ROWS,
    cols,
    rows,
    // CSS pixels; the screencast image is viewport * scale device pixels.
    viewport: {
      width: Math.round((cols * cell.w) / density),
      height: Math.round((rows * cell.h) / density),
    },
  };
}

// In-band resize reports (DECSET 2048): CSI 48 ; rows ; cols ; hpx ; wpx t.
// Herdr sends one on enable and on every resize, including when a client in a
// different terminal attaches, so the cell size never goes stale.
const SIZE_REPORT = /\x1b\[48;(\d+);(\d+);(\d+);(\d+)t/g;
function takeSizeReports(chunk) {
  let latest = null;
  for (const m of chunk.matchAll(SIZE_REPORT)) latest = m;
  if (latest) {
    const [rows, cols, hpx, wpx] = latest.slice(1).map(Number);
    if (rows && cols && hpx && wpx) {
      cell = { w: Math.round(wpx / cols), h: Math.round(hpx / rows) };
      cellSource = 'terminal';
    }
  }
  return { changed: Boolean(latest), rest: chunk.replace(SIZE_REPORT, '') };
}

// --- status bar -------------------------------------------------------------
const stats = { frames: 0, bytes: 0, fps: 0, kbps: 0, dropped: 0 };
let currentUrl = '';
let editing = null; // string while the URL bar is being edited
let port = 0;
let tabCount = 0;

let lastStatus = '';
function drawStatus() {
  const left = editing !== null
    ? ` url> ${editing}█`
    : ` ${currentUrl || 'about:blank'}`;
  const right = `${stats.fps}fps ${stats.kbps}KB/s drop:${stats.dropped} ${fast ? 'fast' : 'sharp'} ${scale}x cell:${cell.w}x${cell.h}${cellSource === 'terminal' ? '' : '?'} tabs:${tabCount} cdp:${port} │ ^L url ^R reload ^S scale ^Q quit `;
  const width = out.columns;
  const room = Math.max(0, width - right.length);
  const line = (left.length > room ? left.slice(0, Math.max(0, room - 1)) + '…' : left.padEnd(room)) + right;
  // Every write makes Herdr re-render (and re-place images), so skip no-op redraws.
  if (line === lastStatus) return;
  lastStatus = line;
  out.write(`\x1b7\x1b[1;1H\x1b[7m${line.slice(0, width)}\x1b[0m\x1b8`);
}

setInterval(() => {
  stats.fps = stats.frames;
  stats.kbps = Math.round(stats.bytes / 1024);
  stats.frames = 0;
  stats.bytes = 0;
  drawStatus();
}, 1000).unref();

// --- frames (latest wins, so a slow terminal never builds up lag) -----------
let writing = false;
let queued = null;
let lastShown = null;
function showFrame(pngBase64) {
  if (pngBase64 === lastShown) return; // static page: nothing to redraw
  if (writing) {
    if (queued) stats.dropped++;
    queued = pngBase64;
    return;
  }
  writing = true;
  lastShown = pngBase64;
  const next = 1 - front;
  const payload = `\x1b[${TOP_ROWS + 1};1H`
    + kittyPng(pngBase64, { id: IMAGE_IDS[next], cols: layout.cols, rows: layout.rows })
    + kittyDelete(IMAGE_IDS[front]);
  front = next;
  stats.frames++;
  stats.bytes += payload.length;
  const flushed = out.write(payload);
  const done = () => {
    writing = false;
    if (queued) { const next = queued; queued = null; showFrame(next); }
  };
  if (flushed) setImmediate(done); else out.once('drain', done);
}

// --- main -------------------------------------------------------------------
async function main() {
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const reported = await queryCellSize();
  if (reported) { cell = reported; cellSource = 'terminal'; }
  computeLayout();
  drawStatus();

  ({ port } = await ensureChrome(profileDir()));
  const base = `http://127.0.0.1:${port}`;

  // Browser-level session: watch tabs come and go (agents open their own).
  const { webSocketDebuggerUrl } = await (await fetch(`${base}/json/version`)).json();
  const browser = await connectCDP(webSocketDebuggerUrl);
  browser.on('close', () => quit(1, 'Chrome exited'));

  // Page-level session for the tab currently shown. Replaced on tab switch;
  // `generation` makes events from a replaced session harmless.
  let cdp = null;
  let currentTarget = null;
  let generation = 0;

  async function pages() {
    const list = await (await fetch(`${base}/json/list`)).json();
    return list.filter((t) => t.type === 'page');
  }

  async function applyViewport() {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: layout.viewport.width,
      height: layout.viewport.height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await cdp.send('Page.stopScreencast').catch(() => {});
    // startScreencast fails with "Not attached to an active page" while a
    // cross-site navigation is swapping renderers; once running it survives them.
    for (let attempt = 0; ; attempt++) {
      try {
        await cdp.send('Page.startScreencast', {
          format: 'png',
          maxWidth: layout.viewport.width * scale,
          maxHeight: layout.viewport.height * scale,
          everyNthFrame: 1,
        });
        return;
      } catch (err) {
        if (attempt >= 20) throw err;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  async function attach(targetId) {
    if (targetId === currentTarget) return;
    const gen = ++generation;
    const previous = cdp;
    const session = await connectCDP(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    if (gen !== generation) { session.close(); return; } // a newer switch won
    cdp = session;
    currentTarget = targetId;
    previous?.close();

    session.on('Page.screencastFrame', ({ data, sessionId }) => {
      session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      if (gen === generation) showFrame(data);
    });
    session.on('Page.frameNavigated', ({ frame }) => {
      if (gen === generation && !frame.parentId) { currentUrl = frame.url; drawStatus(); }
    });
    session.on('close', () => { if (gen === generation) showAnyTab(); });

    await session.send('Page.enable');
    const { frameTree } = await session.send('Page.getFrameTree');
    currentUrl = frameTree.frame.url;
    await session.send('Page.bringToFront').catch(() => {});
    await applyViewport();
    drawStatus();
  }

  async function showAnyTab() {
    currentTarget = null;
    const list = await pages().catch(() => []);
    tabCount = list.length;
    if (list.length) return attach(list[0].id);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    return attach(targetId);
  }

  const recount = () => pages().then((list) => { tabCount = list.length; drawStatus(); }).catch(() => {});

  // setDiscoverTargets replays targetCreated for tabs that already exist; only
  // tabs we haven't seen should steal the view.
  const known = new Set();
  browser.on('Target.targetCreated', ({ targetInfo }) => {
    if (targetInfo.type !== 'page' || known.has(targetInfo.targetId)) return;
    known.add(targetInfo.targetId);
    recount();
    attach(targetInfo.targetId).catch(() => {});
  });
  browser.on('Target.targetDestroyed', ({ targetId }) => {
    known.delete(targetId);
    recount();
    if (targetId === currentTarget) showAnyTab().catch(() => {});
  });

  const existing = await pages();
  for (const t of existing) known.add(t.id);
  tabCount = existing.length;
  await (existing.length ? attach(existing[0].id) : showAnyTab());
  await browser.send('Target.setDiscoverTargets', { discover: true });

  const startUrl = process.env.HERDR_BROWSER_URL ?? process.argv[2]
    ?? (currentUrl === 'about:blank' ? 'http://localhost:3000' : null);
  if (startUrl) await cdp.send('Page.navigate', { url: startUrl });

  // Re-render only when the pixel layout really changed: a resize fires both
  // SIGWINCH and a size report.
  let layoutKey = JSON.stringify([layout, scale]);
  async function relayout() {
    computeLayout();
    const key = JSON.stringify([layout, scale]);
    if (key === layoutKey) return;
    layoutKey = key;
    lastShown = null;
    lastStatus = '';
    out.write(kittyDeleteAll + '\x1b[2J');
    drawStatus();
    await applyViewport().catch(() => {});
  }
  out.on('resize', relayout);

  // Mouse: buttons + drag (1002), SGR encoding (1006). Size reports (2048).
  out.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2048h');

  process.stdin.on('data', async (buf) => {
    const sized = takeSizeReports(buf.toString());
    if (sized.changed) await relayout();
    const chunk = sized.rest;
    for (const ev of parseMouse(chunk)) {
      // Clicking the status bar edits the URL.
      if (ev.row <= TOP_ROWS && !ev.release && !(ev.code & 32)) { editing = ''; drawStatus(); continue; }
      await dispatchMouse(cdp, ev, layout).catch(() => {});
    }
    const keys = stripMouse(chunk);
    if (!keys) return;

    if (keys === '\x11') return quit(0); // ^Q
    if (editing !== null) {
      if (keys === '\r') {
        let url = editing.trim();
        if (url && !/^[a-z]+:/i.test(url)) url = /^(localhost|127\.|\d+$)/.test(url) ? `http://${/^\d+$/.test(url) ? 'localhost:' + url : url}` : `https://${url}`;
        editing = null;
        if (url) await cdp.send('Page.navigate', { url }).catch(() => {});
      } else if (keys === '\x1b') editing = null;
      else if (keys === '\x7f') editing = editing.slice(0, -1);
      else editing += [...keys].filter((c) => c >= ' ').join('');
      drawStatus();
      return;
    }
    if (keys === '\x0c') { editing = ''; drawStatus(); return; } // ^L
    if (keys === '\x12') { await cdp.send('Page.reload').catch(() => {}); return; } // ^R
    if (keys === '\x13') { fast = !fast; await relayout(); return; } // ^S
    await dispatchKeys(cdp, keys).catch(() => {});
  });

  // Closing the pane leaves Chrome running for the workspace's agents;
  // the workspace.closed hook stops it.
  function quit(code, msg) {
    out.write('\x1b[?2048l\x1b[?1006l\x1b[?1002l\x1b[?1000l' + kittyDeleteAll + '\x1b[?25h\x1b[?1049l');
    if (msg) console.error(msg);
    cdp?.close();
    browser.close();
    process.exit(code);
  }
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0));
}

main().catch((err) => {
  out.write('\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l');
  console.error(err.stack ?? err);
  process.exit(1);
});
