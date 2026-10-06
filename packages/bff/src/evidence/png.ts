// PNG decoder for the one PNG an evidence photo can be: a live WhatsApp image (docs/architecture.md
// §6, a PNG becomes JPEG before it is kept). Non-interlaced PNG of every color type, 1-16 bits, with
// the palette's transparency; alpha is composited over white. The decompressed size is bounded by
// the header before inflating, so a small file cannot expand into a huge buffer. What it cannot
// decode (Adam7 interlacing, a corrupt stream, a picture over the pixel limit) throws
// `PngDecodeError` and the photo gets the fixed notice instead of a conversion.
import { inflateSync } from "node:zlib";
import type { RgbImage } from "./jpeg-encoder";

/** Pixels of a photo the evidence converts (24 MP: a 6000×4000 camera picture). */
export const MAX_PNG_PIXELS = 24_000_000;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

export class PngDecodeError extends Error {
  override readonly name = "PngDecodeError";
}

interface Header {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly colorType: number;
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 24) >>> 0) + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0);
}

function readHeader(data: Uint8Array): Header {
  if (data.length !== 13) throw new PngDecodeError("bad IHDR");
  const header = { width: readUint32(data, 0), height: readUint32(data, 4), depth: data[8] ?? 0, colorType: data[9] ?? 0 };
  if (header.width < 1 || header.height < 1 || header.width * header.height > MAX_PNG_PIXELS) throw new PngDecodeError("picture size outside the limit");
  if (!(DEPTHS[header.colorType] ?? []).includes(header.depth)) throw new PngDecodeError("unsupported color type or bit depth");
  if ((data[10] ?? 0) !== 0 || (data[11] ?? 0) !== 0) throw new PngDecodeError("unsupported compression or filter method");
  if ((data[12] ?? 0) !== 0) throw new PngDecodeError("interlaced PNG");
  return header;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Undoes the five scanline filters in place; returns the raw rows without their filter bytes. */
function unfilter(inflated: Uint8Array, rowBytes: number, rows: number, bytesPerPixel: number): Uint8Array {
  const out = new Uint8Array(rowBytes * rows);
  for (let row = 0; row < rows; row += 1) {
    const filter = inflated[row * (rowBytes + 1)] ?? 0;
    const source = row * (rowBytes + 1) + 1;
    const target = row * rowBytes;
    for (let i = 0; i < rowBytes; i += 1) {
      const raw = inflated[source + i] ?? 0;
      const left = i >= bytesPerPixel ? (out[target + i - bytesPerPixel] ?? 0) : 0;
      const up = row > 0 ? (out[target - rowBytes + i] ?? 0) : 0;
      const upLeft = row > 0 && i >= bytesPerPixel ? (out[target - rowBytes + i - bytesPerPixel] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4:
          value = raw + paeth(left, up, upLeft);
          break;
        default:
          throw new PngDecodeError("bad filter type");
      }
      out[target + i] = value & 0xff;
    }
  }
  return out;
}

/** Sample `index` of a row as 0-255 (high byte of 16-bit samples, scaled low bit depths). */
function sample(row: Uint8Array, offset: number, index: number, depth: number, scale: boolean): number {
  if (depth === 8) return row[offset + index] ?? 0;
  if (depth === 16) return row[offset + index * 2] ?? 0;
  const perByte = 8 / depth;
  const byte = row[offset + Math.floor(index / perByte)] ?? 0;
  const shift = 8 - depth * ((index % perByte) + 1);
  const value = (byte >> shift) & ((1 << depth) - 1);
  return scale ? Math.round((value * 255) / ((1 << depth) - 1)) : value;
}

const over = (value: number, alpha: number) => Math.round((value * alpha + 255 * (255 - alpha)) / 255);

/** Decodes a PNG into RGB pixels; throws `PngDecodeError` on anything it does not support. */
export function decodePng(bytes: Uint8Array): RgbImage {
  if (!SIGNATURE.every((value, index) => bytes[index] === value)) throw new PngDecodeError("not a PNG");
  let header: Header | undefined;
  let palette: Uint8Array | undefined;
  let alphaTable: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new PngDecodeError("truncated chunk");
    if (type === "IHDR") header = readHeader(data);
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") alphaTable = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (header === undefined || idat.length === 0) throw new PngDecodeError("missing IHDR or IDAT");
  const { width, height, depth, colorType } = header;
  if (colorType === 3 && palette === undefined) throw new PngDecodeError("missing palette");
  const channels = CHANNELS[colorType] ?? 1;
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const expected = (rowBytes + 1) * height;
  let inflated: Uint8Array;
  try {
    inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (error) {
    throw new PngDecodeError(`image data does not inflate: ${error instanceof Error ? error.name : "error"}`);
  }
  if (inflated.length < expected) throw new PngDecodeError("truncated image data");
  const raw = unfilter(inflated, rowBytes, height, Math.max(1, Math.ceil((channels * depth) / 8)));

  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 3;
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (colorType === 3) {
        const index = sample(raw, rowOffset, x, depth, false);
        r = palette?.[index * 3] ?? 0;
        g = palette?.[index * 3 + 1] ?? 0;
        b = palette?.[index * 3 + 2] ?? 0;
        a = alphaTable?.[index] ?? 255;
      } else if (colorType === 0 || colorType === 4) {
        r = g = b = sample(raw, rowOffset, x * channels, depth, true);
        if (colorType === 4) a = sample(raw, rowOffset, x * channels + 1, depth, true);
      } else {
        r = sample(raw, rowOffset, x * channels, depth, true);
        g = sample(raw, rowOffset, x * channels + 1, depth, true);
        b = sample(raw, rowOffset, x * channels + 2, depth, true);
        if (colorType === 6) a = sample(raw, rowOffset, x * channels + 3, depth, true);
      }
      rgb[target] = over(r, a);
      rgb[target + 1] = over(g, a);
      rgb[target + 2] = over(b, a);
    }
  }
  return { width, height, rgb };
}
