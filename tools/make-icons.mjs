// Draws the app icon (sunset over the sea) as PNGs. Run: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function draw(size) {
  const top = hex("#D93366"), mid = hex("#EF7A45"), low = hex("#F5BE4B");
  const sea = hex("#0B7F7C"), deep = hex("#0F2A30"), sun = hex("#FFF1C9"), glint = hex("#FFD27A");
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const horizon = 0.64, sx = 0.5, sy = 0.6, sr = 0.2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      let c;
      if (v < horizon) {
        c = v < horizon / 2 ? mix(top, mid, v / (horizon / 2)) : mix(mid, low, (v - horizon / 2) / (horizon / 2));
        const d = Math.hypot(u - sx, v - sy);
        if (d < sr) c = sun;
        else if (d < sr + 0.012) c = mix(sun, c, (d - sr) / 0.012);
      } else {
        const t = (v - horizon) / (1 - horizon);
        c = mix(sea, deep, t);
        // sun reflection: broken horizontal bands that narrow with depth
        const band = Math.floor(t * 9);
        const half = sr * (1 - t * 0.75) * (band % 2 ? 0.55 : 0.85);
        if (Math.abs(u - sx) < half && (t * 9) % 1 < 0.55) c = mix(glint, c, t * 0.6);
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync(new URL("../icons/", import.meta.url), { recursive: true });
for (const [name, size] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]]) {
  writeFileSync(new URL("../icons/" + name, import.meta.url), draw(size));
}
console.log("icons written");
