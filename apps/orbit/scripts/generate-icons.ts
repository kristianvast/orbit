import { writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const ICONS_DIR = join(import.meta.dir, "../src-tauri/icons");

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Orbit">
  <title>Orbit</title>
  <rect width="512" height="512" rx="112" fill="#181612"/>
  <circle cx="256" cy="256" r="196" fill="none" stroke="#e88245" stroke-opacity="0.28" stroke-width="8" stroke-dasharray="18 14"/>
  <circle cx="256" cy="256" r="142" fill="none" stroke="#5ec28f" stroke-opacity="0.55" stroke-width="10"/>
  <circle cx="256" cy="256" r="88" fill="none" stroke="#e88245" stroke-width="12"/>
  <circle cx="256" cy="256" r="38" fill="#e88245"/>
  <circle cx="326" cy="202" r="16" fill="#f3f0e6" stroke="#e88245" stroke-width="6"/>
  <circle cx="138" cy="336" r="18" fill="#5ec28f" stroke="#181612" stroke-width="6"/>
  <circle cx="388" cy="112" r="14" fill="#e88245" stroke="#181612" stroke-width="5"/>
</svg>
`;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function renderOrbitRgba(size: number): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const half = size / 2;
  const scale = size / 512;

  const sat1x = 326 * scale;
  const sat1y = 202 * scale;
  const sat2x = 138 * scale;
  const sat2y = 336 * scale;
  const sat3x = 388 * scale;
  const sat3y = 112 * scale;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const idx = rowStart + 1 + x * 4;
      const dx = x + 0.5 - half;
      const dy = y + 0.5 - half;
      const dist = Math.hypot(dx, dy);

      let r = 24;
      let g = 22;
      let b = 18;
      const a = 255;

      const rCore = 38 * scale;
      const rRing1 = 88 * scale;
      const rRing2 = 142 * scale;
      const rRing3 = 196 * scale;
      const stroke1 = Math.max(1.2, 6 * scale);
      const stroke2 = Math.max(1.1, 5 * scale);
      const stroke3 = Math.max(1.0, 4 * scale);

      if (dist <= rCore) {
        r = 232;
        g = 130;
        b = 69;
      } else if (Math.abs(dist - rRing1) <= stroke1) {
        r = 232;
        g = 130;
        b = 69;
      } else if (Math.abs(dist - rRing2) <= stroke2) {
        r = 94;
        g = 194;
        b = 143;
      } else if (Math.abs(dist - rRing3) <= stroke3) {
        r = 128;
        g = 78;
        b = 44;
      }

      const dSat1 = Math.hypot(x + 0.5 - sat1x, y + 0.5 - sat1y);
      const dSat2 = Math.hypot(x + 0.5 - sat2x, y + 0.5 - sat2y);
      const dSat3 = Math.hypot(x + 0.5 - sat3x, y + 0.5 - sat3y);

      if (dSat1 <= Math.max(1.5, 16 * scale)) {
        r = 243;
        g = 240;
        b = 230;
      } else if (dSat2 <= Math.max(1.5, 18 * scale)) {
        r = 94;
        g = 194;
        b = 143;
      } else if (dSat3 <= Math.max(1.4, 14 * scale)) {
        r = 232;
        g = 130;
        b = 69;
      }

      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = a;
    }
  }
  return raw;
}

function encodePng(size: number): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = renderOrbitRgba(size);
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function encodeIco(png32: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = 32;
  entry[1] = 32;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png32.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, png32]);
}

function encodeIcns(png256: Buffer): Buffer {
  const totalLen = 8 + 8 + png256.length;
  const out = Buffer.alloc(totalLen);
  out.write("icns", 0, "ascii");
  out.writeUInt32BE(totalLen, 4);
  out.write("ic08", 8, "ascii");
  out.writeUInt32BE(8 + png256.length, 12);
  png256.copy(out, 16);
  return out;
}

const png32 = encodePng(32);
const png128 = encodePng(128);
const png256 = encodePng(256);
const png512 = encodePng(512);

writeFileSync(join(ICONS_DIR, "icon.svg"), ICON_SVG);
writeFileSync(join(ICONS_DIR, "32x32.png"), png32);
writeFileSync(join(ICONS_DIR, "128x128.png"), png128);
writeFileSync(join(ICONS_DIR, "128x128@2x.png"), png256);
writeFileSync(join(ICONS_DIR, "icon.png"), png512);
writeFileSync(join(ICONS_DIR, "icon.ico"), encodeIco(png32));
writeFileSync(join(ICONS_DIR, "icon.icns"), encodeIcns(png256));
