// Terminal input -> Chrome input.
//
// With SGR mouse reporting on (DECSET 1006), the terminal sends
//   ESC [ < button ; col ; row M   (press / motion)
//   ESC [ < button ; col ; row m   (release)
// where col/row are 1-based terminal cells relative to this pane.

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const BUTTONS = ['left', 'middle', 'right'];

/**
 * Map a terminal cell to a CSS pixel in the page.
 *
 * @param {number} col     1-based column from the SGR report
 * @param {number} row     1-based row from the SGR report
 * @param {object} layout
 *   layout.topRows    rows above the page image (the status bar), e.g. 1
 *   layout.cols       width of the page image in cells
 *   layout.rows       height of the page image in cells
 *   layout.viewport   { width, height } of the page in CSS pixels
 * @returns {{x:number, y:number} | null}  null = the click isn't on the page
 */
export function cellToPage(col, row, layout) {
  // Position inside the page image, in cells, 0-based (status bar excluded).
  const c = col - 1;
  const r = row - 1 - layout.topRows;
  if (c < 0 || r < 0 || c >= layout.cols || r >= layout.rows) return null;

  // Aim at the cell's center: a cell covers ~8x16 CSS px, so this halves the error.
  return {
    x: Math.round(((c + 0.5) / layout.cols) * layout.viewport.width),
    y: Math.round(((r + 0.5) / layout.rows) * layout.viewport.height),
  };
}

export function parseMouse(chunk) {
  const events = [];
  for (const m of chunk.matchAll(SGR_MOUSE)) {
    const code = Number(m[1]);
    events.push({ code, col: Number(m[2]), row: Number(m[3]), release: m[4] === 'm' });
  }
  return events;
}

export function stripMouse(chunk) {
  return chunk.replace(SGR_MOUSE, '');
}

// Wheel buttons (low two bits after the 64 flag): 0 up, 1 down, 2 left, 3 right.
// Trackpads mix in left/right ticks during vertical swipes, so they must not be
// read as up/down. Modifier bits (4/8/16) are masked off.
const WHEEL_STEP = 50; // CSS px per tick: trackpads send many small ticks
const WHEEL_DELTAS = [[0, -WHEEL_STEP], [0, WHEEL_STEP], [-WHEEL_STEP, 0], [WHEEL_STEP, 0]];

// Ticks arrive in bursts; send one wheel event per ~frame instead of dozens.
let wheel = null;
function queueWheel(cdp, x, y, code) {
  const [dx, dy] = WHEEL_DELTAS[code & 3];
  if (wheel) {
    wheel.dx += dx;
    wheel.dy += dy;
    return;
  }
  wheel = { x, y, dx, dy };
  setTimeout(() => {
    const w = wheel;
    wheel = null;
    if (w.dx || w.dy) {
      cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: w.x, y: w.y, deltaX: w.dx, deltaY: w.dy,
      }).catch(() => {});
    }
  }, 16);
}

export async function dispatchMouse(cdp, ev, layout) {
  const pos = cellToPage(ev.col, ev.row, layout);
  if (!pos) return;
  const { x, y } = pos;

  if (ev.code & 64) {
    queueWheel(cdp, x, y, ev.code);
    return;
  }

  const button = BUTTONS[ev.code & 3] ?? 'none';
  const motion = Boolean(ev.code & 32);
  const type = ev.release ? 'mouseReleased' : motion ? 'mouseMoved' : 'mousePressed';
  await cdp.send('Input.dispatchMouseEvent', {
    type, x, y,
    button: motion && (ev.code & 3) === 3 ? 'none' : button,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
}

const SPECIAL_KEYS = {
  '\r': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  '\x7f': { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  '\t': { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  '\x1b': { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  '\x1b[A': { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  '\x1b[B': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  '\x1b[C': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  '\x1b[D': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
};

export async function dispatchKeys(cdp, text) {
  if (SPECIAL_KEYS[text]) {
    const k = SPECIAL_KEYS[text];
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined });
    return;
  }
  for (const ch of text) {
    if (ch < ' ') continue; // unmapped control chars
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
}
