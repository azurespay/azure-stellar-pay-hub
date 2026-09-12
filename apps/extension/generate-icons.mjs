/**
 * Generates proper PNG icons for the StellarPay Hub Chrome extension.
 *
 * Produces three sizes: 16×16, 48×48, 128×128
 * Design: indigo-to-purple gradient background with a white star motif.
 *
 * Usage: node generate-icons.mjs
 */

import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, 'icons');

// ── Color helpers ──────────────────────────────────────────────────────────
function blend(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    255,
  ];
}

const INDIGO = [79, 70, 229, 255]; // #4F46E5
const PURPLE = [124, 58, 237, 255]; // #7C3AED
const WHITE = [255, 255, 255, 255];

// ── Draw functions ─────────────────────────────────────────────────────────
function drawGradient(pixels, w, h) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const idx = (y * w + x) * 4;
      const c = blend(INDIGO, PURPLE, t);
      pixels[idx] = c[0];
      pixels[idx + 1] = c[1];
      pixels[idx + 2] = c[2];
      pixels[idx + 3] = c[3];
    }
  }
}

function drawPixel(pixels, w, x, y, color) {
  if (x < 0 || x >= w || y < 0 || y >= w) return;
  const idx = (y * w + x) * 4;
  pixels[idx] = color[0];
  pixels[idx + 1] = color[1];
  pixels[idx + 2] = color[2];
  pixels[idx + 3] = color[3];
}

function drawLine(pixels, w, x1, y1, x2, y2, color) {
  // Integer Bresenham with max-iteration guard
  let x = Math.round(x1),
    y = Math.round(y1);
  const tx = Math.round(x2),
    ty = Math.round(y2);
  const dx = Math.abs(tx - x),
    dy = -Math.abs(ty - y);
  const sx = x < tx ? 1 : -1,
    sy = y < ty ? 1 : -1;
  let err = dx + dy;
  const maxIter = Math.max(dx, -dy) + 2;
  for (let i = 0; i < maxIter; i++) {
    drawPixel(pixels, w, x, y, color);
    if (x === tx && y === ty) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function drawFilledCircle(pixels, w, cx, cy, r, color) {
  for (let y = Math.max(0, Math.ceil(cy - r)); y < Math.min(w, Math.floor(cy + r + 1)); y++) {
    for (let x = Math.max(0, Math.ceil(cx - r)); x < Math.min(w, Math.floor(cx + r + 1)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r ** 2) {
        drawPixel(pixels, w, x, y, color);
      }
    }
  }
}

function drawStar(pixels, w, cx, cy, outerR, innerR, points, color) {
  const step = Math.PI / points;
  const startAngle = -Math.PI / 2;
  for (let p = 0; p < points * 2; p++) {
    const angle = startAngle + p * step;
    const r = p % 2 === 0 ? outerR : innerR;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    const nextAngle = startAngle + (p + 1) * step;
    const nextR = (p + 1) % 2 === 0 ? outerR : innerR;
    const nx = cx + Math.cos(nextAngle) * nextR;
    const ny = cy + Math.sin(nextAngle) * nextR;
    drawLine(pixels, w, x, y, nx, ny, color);
  }
}

// ── Draw designs per size ──────────────────────────────────────────────────
function drawDesign(pixels, w) {
  drawGradient(pixels, w, w);

  const cx = w / 2 - 0.5;
  const cy = w / 2 - 0.5;

  if (w === 16) {
    // 16×16: simple 4-point diamond star
    drawStar(pixels, w, cx, cy, 5.5, 2.0, 4, WHITE);
    drawFilledCircle(pixels, w, cx, cy, 1.2, [255, 255, 220, 255]);
  } else if (w === 48) {
    // 48×48: 5-point star with glow
    const GLOW = [200, 210, 255, 120];
    drawFilledCircle(pixels, w, cx, cy, 17, [99, 102, 241, 60]);
    drawStar(pixels, w, cx, cy, 15, 6.5, 5, GLOW);
    drawStar(pixels, w, cx, cy, 14, 5.5, 5, WHITE);
    drawFilledCircle(pixels, w, cx, cy, 3, [255, 255, 220, 255]);
    // Small corner highlights
    drawFilledCircle(pixels, w, cx - 9, cy - 9, 1.5, [255, 255, 255, 200]);
    drawFilledCircle(pixels, w, cx + 9, cy - 10, 1.0, [255, 255, 255, 140]);
  } else if (w === 128) {
    // 128×128: detailed star with glow rings and highlight
    // Outer glow
    drawFilledCircle(pixels, w, cx, cy, 52, [99, 102, 241, 30]);
    drawFilledCircle(pixels, w, cx, cy, 42, [129, 140, 248, 40]);
    // Star
    drawStar(pixels, w, cx, cy, 40, 16, 5, [180, 190, 255, 200]);
    drawStar(pixels, w, cx, cy, 37, 14, 5, [220, 225, 255, 255]);
    drawStar(pixels, w, cx, cy, 35, 13, 5, WHITE);
    // Center
    drawFilledCircle(pixels, w, cx, cy, 7, [255, 255, 220, 255]);
    drawFilledCircle(pixels, w, cx, cy, 4, [255, 255, 255, 230]);
    // Corner sparkles
    const sparkles = [
      [cx - 30, cy - 30, 3.0],
      [cx + 28, cy - 32, 2.5],
      [cx - 35, cy + 27, 2.0],
      [cx + 33, cy + 30, 2.8],
    ];
    for (const [sx, sy, sr] of sparkles) {
      drawFilledCircle(pixels, w, sx, sy, sr, [200, 210, 255, 200]);
      drawFilledCircle(pixels, w, sx, sy, sr * 0.4, [255, 255, 255, 180]);
    }
  }
}

// ── PNG encoder ────────────────────────────────────────────────────────────
function crc32(data) {
  let crc = 0xffffffff;
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  for (const b of data) {
    crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crcBuf]);
}

function encodePNG(pixels, w, h) {
  // Apply PNG filter byte (0 = None) to each row
  const rawRows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    row[0] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      row[1 + x * 4] = pixels[idx]; // R
      row[1 + x * 4 + 1] = pixels[idx + 1]; // G
      row[1 + x * 4 + 2] = pixels[idx + 2]; // B
      row[1 + x * 4 + 3] = pixels[idx + 3]; // A
    }
    rawRows.push(row);
  }

  const rawData = Buffer.concat(rawRows);
  console.log(`    Compressing ${w}×${w} (${rawData.length} bytes raw)...`);
  const compressed = zlib.deflateSync(rawData, { level: 0 });

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0);
  ihdrData.writeUInt32BE(h, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  return Buffer.concat([
    signature,
    createChunk('IHDR', ihdrData),
    createChunk('IDAT', compressed),
    createChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  if (!existsSync(ICONS_DIR)) {
    mkdirSync(ICONS_DIR, { recursive: true });
  }

  for (const size of [16, 48, 128]) {
    console.log(`  Generating ${size}×${size}...`);
    const pixels = new Uint8Array(size * size * 4);
    console.log(`    Drawing design...`);
    drawDesign(pixels, size);
    console.log(`    Encoding PNG...`);
    const png = encodePNG(pixels, size, size);
    const path = join(ICONS_DIR, `icon${size}.png`);
    createWriteStream(path).end(png);
    console.log(`  ✓ icon${size}.png — ${size}×${size}, ${(png.length / 1024).toFixed(1)} KB`);
  }

  console.log(`\n✅ Icons generated in ${ICONS_DIR}/`);
  console.log('   Ready for Chrome Web Store submission.');
}

main();
