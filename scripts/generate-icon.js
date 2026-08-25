/**
 * Generates media/icon.png (128x128) without any image dependency.
 * Raw RGBA is encoded into a PNG using Node's built-in zlib.
 *
 * Run with: node scripts/generate-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const SAMPLES = 4; // supersampling factor per axis, for smooth edges

// ---------- PNG encoding ----------

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- geometry ----------

/** Signed coverage test for a rounded rectangle. */
function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) {
    return false;
  }
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** Point-in-triangle test using barycentric sign checks. */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Background gradient: blue at the top, violet at the bottom.
const TOP = [37, 99, 235];
const BOTTOM = [124, 58, 237];
const FG = [255, 255, 255];

/** Returns [r, g, b, a] for a sample point, or null for transparent. */
function sample(x, y) {
  const inBackground = inRoundedRect(x, y, 4, 4, SIZE - 4, SIZE - 4, 26);
  if (!inBackground) {
    return null;
  }

  const t = (y - 4) / (SIZE - 8);
  const bg = [
    lerp(TOP[0], BOTTOM[0], t),
    lerp(TOP[1], BOTTOM[1], t),
    lerp(TOP[2], BOTTOM[2], t)
  ];

  // Play triangle.
  if (inTriangle(x, y, 48, 32, 48, 84, 94, 58)) {
    return [FG[0], FG[1], FG[2], 255];
  }
  // Three request lines under the triangle, shortest last.
  if (inRoundedRect(x, y, 34, 94, 94, 102, 4)) {
    return [FG[0], FG[1], FG[2], 255];
  }
  if (inRoundedRect(x, y, 34, 74, 40, 84, 3)) {
    return [FG[0], FG[1], FG[2], 255];
  }
  if (inRoundedRect(x, y, 34, 56, 40, 66, 3)) {
    return [FG[0], FG[1], FG[2], 255];
  }
  if (inRoundedRect(x, y, 34, 38, 40, 48, 3)) {
    return [FG[0], FG[1], FG[2], 255];
  }

  return [bg[0], bg[1], bg[2], 255];
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const step = 1 / SAMPLES;

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const value = sample(px + (sx + 0.5) * step, py + (sy + 0.5) * step);
          if (value) {
            r += value[0];
            g += value[1];
            b += value[2];
            a += value[3];
          }
        }
      }
      const total = SAMPLES * SAMPLES;
      const alpha = a / total;
      const offset = (py * SIZE + px) * 4;
      // Premultiplied averaging would darken edges, so normalise by covered samples.
      const covered = a === 0 ? 1 : a / 255;
      rgba[offset] = Math.round(r / covered / 1);
      rgba[offset + 1] = Math.round(g / covered / 1);
      rgba[offset + 2] = Math.round(b / covered / 1);
      rgba[offset + 3] = Math.round(alpha);
    }
  }

  return rgba;
}

const outputDir = path.join(__dirname, '..', 'media');
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'icon.png');
fs.writeFileSync(outputPath, encodePng(SIZE, SIZE, render()));
console.log(`Wrote ${outputPath} (${fs.statSync(outputPath).size} bytes)`);
