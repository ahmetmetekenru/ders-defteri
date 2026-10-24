// Uygulama ikonlarını (PNG) üretir: siyah zemin, A4 kâğıt, sarı başlık çizgisi.
// Çalıştırma: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x / size, y / size);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const GROUND = [19, 19, 21];
const PAPER = [3, 3, 3];
const EDGE = [70, 70, 78];
const RULE = [42, 42, 48];
const YELLOW = [255, 216, 77];
const BLUE = [90, 169, 255];

// Kâğıt maskelenebilir alanın içinde kalsın diye ortada ve küçük tutuldu
function pixel(u, v) {
  const left = 0.3, right = 0.7, top = 0.22, bottom = 0.78;
  const inside = u > left && u < right && v > top && v < bottom;
  const onEdge = inside && (u < left + 0.012 || u > right - 0.012 || v < top + 0.012 || v > bottom - 0.012);
  if (!inside) return GROUND;
  if (onEdge) return EDGE;
  if (v > top && v < top + 0.03) return YELLOW;
  if (u > left + 0.06 && u < left + 0.27 && v > 0.32 && v < 0.355) return YELLOW;
  if (u > left + 0.06 && u < left + 0.2 && v > 0.53 && v < 0.565) return BLUE;
  for (const lv of [0.41, 0.46, 0.62, 0.67, 0.72]) {
    if (u > left + 0.06 && u < right - 0.06 && Math.abs(v - lv) < 0.006) return RULE;
  }
  return PAPER;
}

mkdirSync("icons", { recursive: true });
writeFileSync("icons/icon-192.png", png(192, pixel));
writeFileSync("icons/icon-512.png", png(512, pixel));
writeFileSync("icons/apple-touch-icon.png", png(180, pixel));
console.log("icons ready");
