// Kitty graphics protocol helpers.
// Spec: https://sw.kovidgoyal.net/kitty/graphics-protocol/

const CHUNK = 4096;

// Transmit + place a PNG scaled into a cols x rows cell box at the cursor.
// Re-sending with the same image id replaces the previous frame in place.
//   f=100  payload is PNG       C=1  don't move the cursor
//   q=2    suppress replies     m=1  more chunks follow
export function kittyPng(pngBase64, { id, cols, rows }) {
  let out = '';
  for (let i = 0; i < pngBase64.length; i += CHUNK) {
    const more = i + CHUNK < pngBase64.length ? 1 : 0;
    const ctrl = i === 0
      ? `a=T,f=100,i=${id},p=1,c=${cols},r=${rows},C=1,q=2,m=${more}`
      : `m=${more}`;
    out += `\x1b_G${ctrl};${pngBase64.slice(i, i + CHUNK)}\x1b\\`;
  }
  return out;
}

export const kittyDeleteAll = '\x1b_Ga=d,d=A,q=2\x1b\\';

// Delete one image and free its data (uppercase I).
export function kittyDelete(id) {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
}
