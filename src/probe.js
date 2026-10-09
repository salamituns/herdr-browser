// Graphics probe: does an image survive the trip pane -> Herdr -> outer terminal?
// Draws a generated gradient PNG; if you see colors, the browser pane can work.
import { deflateSync } from 'node:zlib';
import { kittyPng, kittyDeleteAll } from './kitty.js';

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function gradientPng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = (x / w) * 255;
      raw[row + 2 + x * 3] = (y / h) * 255;
      raw[row + 3 + x * 3] = 160;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const cols = Math.min(40, process.stdout.columns - 2);
const rows = Math.min(12, process.stdout.rows - 6);
process.stdout.write('\x1b[2J\x1b[H');
process.stdout.write(`TERM_PROGRAM=${process.env.TERM_PROGRAM}  pane=${process.stdout.columns}x${process.stdout.rows}\r\n\r\n`);
process.stdout.write(kittyPng(gradientPng(320, 160).toString('base64'), { id: 7, cols, rows }));
process.stdout.write(`\x1b[${rows + 4};1H`);
process.stdout.write('See a red/green gradient above?  YES -> graphics work.  Blank -> outer terminal lacks Kitty graphics.\r\n');
process.stdout.write('Press any key to close.');
process.stdin.setRawMode(true);
process.stdin.once('data', () => { process.stdout.write(kittyDeleteAll); process.exit(0); });
