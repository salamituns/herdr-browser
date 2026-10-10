// Browser pane: stream the workspace's headless Chrome into this pane as
// Kitty graphics, and forward mouse/keyboard back to it over CDP.
// The pane follows tabs: when an agent opens a tab, the pane switches to it.
import { connectCDP } from './cdp.js';
import { ensureChrome } from './chrome.js';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kittyPng, kittyPngFile, kittyDelete, kittyDeleteAll } from './kitty.js';
import { dispatchKeys, dispatchMouse, parseMouse, stripMouse } from './input.js';
import { profileDir, refreshCurrentLink, stateDir } from './paths.js';

// Herdr closes the pane when this process exits, so one failed CDP call (an
// agent closing the tab we were switching to, say) must not take it down.
// Log the error and keep streaming.
const LOG = join(stateDir, 'pane.log');
function logError(err) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} ${err?.stack ?? err}\n`);
  } catch {}
}
process.on('unhandledRejection', logError);
process.on('uncaughtException', logError);

const out = process.stdout;
// Double buffering: alternate two image ids and place the new frame over the
// old one before deleting it. Replacing a single id makes Herdr delete the old
// image first, leaving a blank gap the outer terminal can paint (flicker).
const IMAGE_IDS = [4242, 4243];
let front = 0;
const TOP_ROWS = 1;
const DEBUG = process.env.HERDR_BROWSER_DEBUG === '1';

// Frame transport: send each frame as a temp-file path (t=t) when the terminal
// accepts it, else inline base64. Probed with a 1x1 PNG and the protocol's own
// OK/error reply. HERDR_BROWSER_TRANSPORT=inline|file forces one.
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let frameDir = null;
let frameSeq = 0;
function probeFileTransport() {
  const forced = process.env.HERDR_BROWSER_TRANSPORT;
  if (forced === 'inline') return Promise.resolve(false);
  frameDir = mkdtempSync(join(tmpdir(), 'herdr-browser-'));
  const path = join(frameDir, 'tty-graphics-protocol-probe.png');
  writeFileSync(path, Buffer.from(PIXEL_PNG, 'base64'));
  if (forced === 'file') return Promise.resolve(true);
  return new Promise((resolve) => {
    let seen = '';
    const done = (ok) => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      out.write(kittyDelete(4240));
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 1000);
    function onData(buf) {
      seen += buf.toString();
      const m = seen.match(/\x1b_Gi=4240;([^\x1b]*)/);
      if (m) done(m[1] === 'OK');
    }
    process.stdin.on('data', onData);
    out.write(`\x1b_Ga=t,t=t,f=100,i=4240,q=0;${Buffer.from(path).toString('base64')}\x1b\\`);
  });
}
let fileTransport = false;

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
// that keeps CSS cells ~8px wide (normal page zoom).
//
// Frame rate: Chrome's PNG encoding is the bottleneck at full Retina size
// (~15-19 fps), not the terminal. So by default ("auto") stream at half
// resolution while the page moves (~30 fps) and send one full-resolution frame
// once it has been still for IDLE_MS. ^S cycles auto / sharp / fast.
const CSS_CELL_WIDTH = 8;
let cell = { w: 8, h: 17 };
let cellSource = 'fallback';
const MODES = ['auto', 'sharp', 'fast'];
let mode = MODES.includes(process.env.HERDR_BROWSER_MODE) ? process.env.HERDR_BROWSER_MODE
  : process.env.HERDR_BROWSER_FAST === '1' ? 'fast' : 'auto';
const IDLE_MS = 150;
let density = 1;
let scale = 1; // Chrome deviceScaleFactor, derived in computeLayout
let layout;
function computeLayout() {
  const cols = out.columns;
  const rows = Math.max(1, out.rows - TOP_ROWS);
  density = Math.max(1, Math.round(cell.w / CSS_CELL_WIDTH));
  scale = density;
  layout = {
    topRows: TOP_ROWS,
    cols,
    rows,
    // CSS pixels; a full-resolution frame is viewport * scale device pixels.
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
  if (latest && cellSource !== 'pinned') {
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
const nextMode = () => MODES[(MODES.indexOf(mode) + 1) % MODES.length];
function drawStatus() {
  const left = editing !== null
    ? ` url> ${editing}█  (Enter go, Esc cancel)`
    : ` ${currentUrl || 'about:blank'}`;
  // The URL gets the room; diagnostics only with HERDR_BROWSER_DEBUG=1.
  const right = DEBUG
    ? `${stats.fps}fps ${stats.kbps}KB/s drop:${stats.dropped} ${fileTransport ? 'file' : 'inline'} ${mode} ${scale}x frame:${stats.frameSize ?? '?'} want:${layout.viewport.width * scale}x${layout.viewport.height * scale} cell:${cell.w}x${cell.h}${cellSource === 'terminal' ? '' : '?'} tabs:${tabCount} cdp:${port} │ ^L url ^R reload ^S ${nextMode()} ^Q quit `
    : `${emulated() ? `${pageCss.width}×${pageCss.height} viewport │ ` : ''}${tabCount > 1 ? `${tabCount} tabs │ ` : ''}${mode === 'auto' ? '' : `${mode} │ `}^L url  ^R reload  ^S ${nextMode()}  ^Q quit `;
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
function placeFrame(pngBase64, opts) {
  if (!fileTransport) return kittyPng(pngBase64, opts);
  const path = join(frameDir, `tty-graphics-protocol-${frameSeq++}.png`);
  writeFileSync(path, Buffer.from(pngBase64, 'base64'));
  return kittyPngFile(path, opts);
}
// CSS size of the page as last streamed. An agent can emulate a viewport (a
// 390px phone, say) that doesn't match the pane; then the frame is shown at its
// real proportions, centered, instead of stretched across the pane.
let pageCss = null;
const emulated = () => pageCss && layout && (Math.abs(pageCss.width - layout.viewport.width) > 2
  || Math.abs(pageCss.height - layout.viewport.height) > 2);
let frameBox = null; // cells the current frame occupies, below the status bar
function fitFrame(w, h) {
  const full = { col: 0, row: 0, cols: layout.cols, rows: layout.rows };
  const ratio = (w / h) / ((layout.cols * cell.w) / (layout.rows * cell.h));
  if (Math.abs(ratio - 1) < 0.03) return full; // the pane's own viewport (rounding)
  if (ratio < 1) {
    const cols = Math.max(1, Math.round(layout.cols * ratio));
    return { ...full, col: Math.floor((layout.cols - cols) / 2), cols };
  }
  return { ...full, rows: Math.max(1, Math.round(layout.rows / ratio)) };
}

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
  const ihdr = Buffer.from(pngBase64.slice(0, 32), 'base64');
  const [w, h] = [ihdr.readUInt32BE(16), ihdr.readUInt32BE(20)];
  if (DEBUG) stats.frameSize = `${w}x${h}`;
  const box = fitFrame(w, h);
  frameBox = box;
  const next = 1 - front;
  const payload = `\x1b[${TOP_ROWS + 1 + box.row};${box.col + 1}H`
    + placeFrame(pngBase64, { id: IMAGE_IDS[next], cols: box.cols, rows: box.rows })
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
  refreshCurrentLink();
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  process.stdin.setRawMode(true);
  process.stdin.resume();

  fileTransport = await probeFileTransport();
  const reported = await queryCellSize();
  if (reported) { cell = reported; cellSource = 'terminal'; }
  // Benchmarking only: pin the cell size (e.g. 16x34) and ignore size reports.
  const pinned = DEBUG && process.env.HERDR_BROWSER_CELL?.match(/^(\d+)x(\d+)$/);
  if (pinned) { cell = { w: Number(pinned[1]), h: Number(pinned[2]) }; cellSource = 'pinned'; }
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

  // Every browser pane in the workspace shows the same tab, and the viewport
  // belongs to whichever set it last. Panes record theirs here so a pane that
  // gains focus can take it back from another pane, but not from an agent
  // that is emulating a phone on purpose.
  const viewportFile = join(profileDir(), 'herdr-browser-viewport.json');
  async function applyViewport() {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: layout.viewport.width,
      height: layout.viewport.height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    try { writeFileSync(viewportFile, JSON.stringify(layout.viewport)); } catch {}
    await cdp.send('Page.stopScreencast').catch(() => {});
    // startScreencast fails with "Not attached to an active page" while a
    // cross-site navigation is swapping renderers; once running it survives them.
    for (let attempt = 0; ; attempt++) {
      try {
        const streamScale = mode === 'sharp' ? scale : Math.max(1, scale / 2);
        await cdp.send('Page.startScreencast', {
          format: 'png',
          maxWidth: layout.viewport.width * streamScale,
          maxHeight: layout.viewport.height * streamScale,
          everyNthFrame: 1,
        });
        return;
      } catch (err) {
        if (attempt >= 20) throw err;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  // After motion stops, replace the half-res stream frame with a full one.
  let lastStreamFrame = null;
  let streamSeq = 0;
  let refineTimer = null;
  function scheduleRefine(session, gen) {
    clearTimeout(refineTimer);
    if (mode !== 'auto' || scale < 2) return;
    refineTimer = setTimeout(async () => {
      const seq = streamSeq;
      try {
        const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
        // Drop it if the page moved on while we were capturing.
        if (gen === generation && seq === streamSeq) showFrame(data);
      } catch {}
    }, IDLE_MS);
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

    session.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
      session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      if (gen !== generation) return;
      if (metadata?.deviceWidth) {
        const css = { width: Math.round(metadata.deviceWidth), height: Math.round(metadata.deviceHeight) };
        const changed = css.width !== pageCss?.width || css.height !== pageCss?.height;
        pageCss = css;
        if (changed) drawStatus();
      }
      // A repaint with no visible change (e.g. caused by our own full-res
      // capture) must not replace the sharp frame or re-arm the timer.
      if (data === lastStreamFrame) return;
      lastStreamFrame = data;
      streamSeq++;
      showFrame(data);
      scheduleRefine(session, gen);
    });
    session.on('Page.frameNavigated', ({ frame }) => {
      if (gen === generation && !frame.parentId) { currentUrl = frame.url; drawStatus(); }
    });
    session.on('close', () => { if (gen === generation) showAnyTab().catch(logError); });

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
    frameBox = null;
    lastStatus = '';
    out.write(kittyDeleteAll + '\x1b[2J');
    drawStatus();
    await applyViewport().catch(() => {});
  }
  out.on('resize', relayout);

  async function onFocus() {
    if (!emulated()) return;
    let set = null;
    try { set = JSON.parse(readFileSync(viewportFile, 'utf8')); } catch {}
    if (set && set.width === pageCss.width && set.height === pageCss.height) {
      // Re-sending our unchanged override is a no-op while another session's
      // override is in effect; clearing ours first makes the new one take.
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await applyViewport().catch(logError);
    }
  }

  // Mouse: buttons + drag (1002), SGR encoding (1006). Size reports (2048).
  // Focus in/out (1004).
  out.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2048h\x1b[?1004h');

  process.stdin.on('data', async (buf) => {
    const sized = takeSizeReports(buf.toString());
    if (sized.changed) await relayout();
    let chunk = sized.rest;
    if (chunk.includes('\x1b[I')) onFocus();
    chunk = chunk.replace(/\x1b\[[IO]/g, ''); // focus reports aren't keystrokes
    for (const ev of parseMouse(chunk)) {
      // Clicking the status bar edits the URL.
      if (ev.row <= TOP_ROWS && !ev.release && !(ev.code & 32)) { editing = ''; drawStatus(); continue; }
      const box = frameBox ?? { col: 0, row: 0, cols: layout.cols, rows: layout.rows };
      const target = { topRows: TOP_ROWS + box.row, cols: box.cols, rows: box.rows, viewport: pageCss ?? layout.viewport };
      await dispatchMouse(cdp, { ...ev, col: ev.col - box.col }, target).catch(() => {});
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
    if (keys === '\x13') { // ^S: auto -> sharp -> fast
      mode = nextMode();
      lastStreamFrame = null;
      drawStatus();
      await applyViewport().catch(() => {});
      return;
    }
    await dispatchKeys(cdp, keys).catch(() => {});
  });

  // Closing the pane leaves Chrome running for the workspace's agents;
  // the workspace.closed hook stops it.
  function quit(code, msg) {
    out.write('\x1b[?1004l\x1b[?2048l\x1b[?1006l\x1b[?1002l\x1b[?1000l' + kittyDeleteAll + '\x1b[?25h\x1b[?1049l');
    if (msg) console.error(msg);
    cdp?.close();
    browser.close();
    if (frameDir) rmSync(frameDir, { recursive: true, force: true });
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
