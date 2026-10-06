// Baseline JPEG encoder (ITU-T T.81): what turns a live PNG photo into the JPEG the evidence keeps
// (docs/architecture.md §6; the certificate embeds only JPEG). 4:4:4 YCbCr, the Annex K quantization
// tables scaled like the IJG library, the Annex K Huffman tables, the float AAN forward DCT, no
// metadata segment but JFIF. Pure code: no image library is declared in the workspace, and an evidence
// photo needs nothing beyond a correct baseline stream.

/** Pixels in RGB order, 3 bytes per pixel, rows top to bottom. */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
}

/** Position k of the zigzag scan → index in the natural (row-major) 8×8 order. */
export const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44,
  51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
] as const;

// Annex K.1, natural order.
const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64,
  81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array<number>(32).fill(99),
];

/** A Huffman table as DHT carries it: code counts by length (1-16) and the symbols in code order. */
export interface HuffmanSpec {
  readonly counts: readonly number[];
  readonly symbols: readonly number[];
}

// Annex K.3.
export const DC_LUMA: HuffmanSpec = { counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
export const DC_CHROMA: HuffmanSpec = { counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
export const AC_LUMA: HuffmanSpec = {
  counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  symbols: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15,
    0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43,
    0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
    0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2,
    0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3,
    0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
export const AC_CHROMA: HuffmanSpec = {
  counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  symbols: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23,
    0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a,
    0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77,
    0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9,
    0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};

/** Code and length of every symbol of a table (Annex C). */
function huffmanCodes(spec: HuffmanSpec): { readonly code: Int32Array; readonly length: Int32Array } {
  const code = new Int32Array(256);
  const length = new Int32Array(256);
  let next = 0;
  let index = 0;
  for (let bits = 1; bits <= 16; bits += 1) {
    for (let n = 0; n < (spec.counts[bits - 1] ?? 0); n += 1) {
      const symbol = spec.symbols[index] ?? 0;
      code[symbol] = next;
      length[symbol] = bits;
      next += 1;
      index += 1;
    }
    next <<= 1;
  }
  return { code, length };
}

/** IJG scaling of a base table to a quality of 1-100 (natural order, 1-255). */
export function scaledQuant(base: readonly number[], quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((value) => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))));
}

// Scale factors of the AAN DCT: cos(k·π/16)·√2, 1 for k = 0.
const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

/** Multipliers that undo the AAN scaling and quantize in one product (natural order). */
function divisors(quant: readonly number[]): Float64Array {
  const out = new Float64Array(64);
  for (let row = 0; row < 8; row += 1) for (let col = 0; col < 8; col += 1) out[row * 8 + col] = 1 / ((quant[row * 8 + col] ?? 1) * (AAN[row] ?? 1) * (AAN[col] ?? 1) * 8);
  return out;
}

/** In-place float AAN forward DCT of one 8×8 block (rows, then columns), as the IJG `jfdctflt`. */
function forwardDct(data: Float64Array): void {
  for (let pass = 0; pass < 2; pass += 1) {
    const step = pass === 0 ? 1 : 8;
    for (let line = 0; line < 8; line += 1) {
      const base = pass === 0 ? line * 8 : line;
      const at = (k: number) => data[base + k * step] ?? 0;
      const tmp0 = at(0) + at(7);
      const tmp7 = at(0) - at(7);
      const tmp1 = at(1) + at(6);
      const tmp6 = at(1) - at(6);
      const tmp2 = at(2) + at(5);
      const tmp5 = at(2) - at(5);
      const tmp3 = at(3) + at(4);
      const tmp4 = at(3) - at(4);
      const tmp10 = tmp0 + tmp3;
      const tmp13 = tmp0 - tmp3;
      const tmp11 = tmp1 + tmp2;
      const tmp12 = tmp1 - tmp2;
      data[base] = tmp10 + tmp11;
      data[base + 4 * step] = tmp10 - tmp11;
      const z1 = (tmp12 + tmp13) * 0.707106781;
      data[base + 2 * step] = tmp13 + z1;
      data[base + 6 * step] = tmp13 - z1;
      const odd10 = tmp4 + tmp5;
      const odd11 = tmp5 + tmp6;
      const odd12 = tmp6 + tmp7;
      const z5 = (odd10 - odd12) * 0.382683433;
      const z2 = 0.5411961 * odd10 + z5;
      const z4 = 1.306562965 * odd12 + z5;
      const z3 = odd11 * 0.707106781;
      const z11 = tmp7 + z3;
      const z13 = tmp7 - z3;
      data[base + 5 * step] = z13 + z2;
      data[base + 3 * step] = z13 - z2;
      data[base + 1 * step] = z11 + z4;
      data[base + 7 * step] = z11 - z4;
    }
  }
}

/** Bit writer of the entropy-coded segment, with the 0xFF byte stuffing of T.81 §B.1.1.5. */
class BitWriter {
  private readonly bytes: number[] = [];
  private buffer = 0;
  private count = 0;

  write(code: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.buffer = (this.buffer << 1) | ((code >> bit) & 1);
      this.count += 1;
      if (this.count === 8) this.flushByte();
    }
  }

  private flushByte(): void {
    this.bytes.push(this.buffer);
    if (this.buffer === 0xff) this.bytes.push(0);
    this.buffer = 0;
    this.count = 0;
  }

  /** Pads the last byte with 1 bits. */
  finish(): number[] {
    if (this.count > 0) this.write((1 << (8 - this.count)) - 1, 8 - this.count);
    return this.bytes;
  }
}

/** Category (bit length) of a coefficient and its T.81 bit pattern. */
function magnitude(value: number): { readonly size: number; readonly bits: number } {
  const abs = Math.abs(value);
  let size = 0;
  while (abs >> size !== 0) size += 1;
  return { size, bits: value < 0 ? value + (1 << size) - 1 : value };
}

interface ComponentTables {
  readonly divisors: Float64Array;
  readonly dc: ReturnType<typeof huffmanCodes>;
  readonly ac: ReturnType<typeof huffmanCodes>;
}

function encodeBlock(block: Float64Array, previousDc: number, tables: ComponentTables, out: BitWriter): number {
  forwardDct(block);
  const coefficients = new Int32Array(64);
  for (let k = 0; k < 64; k += 1) {
    const natural = ZIGZAG[k] ?? 0;
    coefficients[k] = Math.round((block[natural] ?? 0) * (tables.divisors[natural] ?? 0));
  }
  const dc = coefficients[0] ?? 0;
  const diff = magnitude(dc - previousDc);
  out.write(tables.dc.code[diff.size] ?? 0, tables.dc.length[diff.size] ?? 0);
  if (diff.size > 0) out.write(diff.bits, diff.size);
  let run = 0;
  for (let k = 1; k < 64; k += 1) {
    const value = coefficients[k] ?? 0;
    if (value === 0) {
      run += 1;
      continue;
    }
    while (run > 15) {
      out.write(tables.ac.code[0xf0] ?? 0, tables.ac.length[0xf0] ?? 0);
      run -= 16;
    }
    const { size, bits } = magnitude(value);
    const symbol = (run << 4) | size;
    out.write(tables.ac.code[symbol] ?? 0, tables.ac.length[symbol] ?? 0);
    out.write(bits, size);
    run = 0;
  }
  if (run > 0) out.write(tables.ac.code[0] ?? 0, tables.ac.length[0] ?? 0);
  return dc;
}

function segment(marker: number, payload: readonly number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

function huffmanSegment(tableClass: number, id: number, spec: HuffmanSpec): number[] {
  return [(tableClass << 4) | id, ...spec.counts, ...spec.symbols];
}

/** Encodes RGB pixels as a baseline JPEG (quality 1-100, 88 by default). */
export function encodeJpeg(image: RgbImage, quality = 88): Uint8Array {
  const { width, height, rgb } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65_535 || height > 65_535) throw new RangeError("image size out of the JPEG range");
  if (rgb.length !== width * height * 3) throw new RangeError("rgb buffer does not match the image size");
  const lumaQuant = scaledQuant(LUMA_QUANT, quality);
  const chromaQuant = scaledQuant(CHROMA_QUANT, quality);
  const luma: ComponentTables = { divisors: divisors(lumaQuant), dc: huffmanCodes(DC_LUMA), ac: huffmanCodes(AC_LUMA) };
  const chroma: ComponentTables = { divisors: divisors(chromaQuant), dc: huffmanCodes(DC_CHROMA), ac: huffmanCodes(AC_CHROMA) };

  const out = new BitWriter();
  const blocks = [new Float64Array(64), new Float64Array(64), new Float64Array(64)] as const;
  const previous = [0, 0, 0];
  for (let top = 0; top < height; top += 8) {
    for (let left = 0; left < width; left += 8) {
      for (let k = 0; k < 64; k += 1) {
        // Edge blocks repeat the last row and column.
        const y = Math.min(top + (k >> 3), height - 1);
        const x = Math.min(left + (k & 7), width - 1);
        const p = (y * width + x) * 3;
        const r = rgb[p] ?? 0;
        const g = rgb[p + 1] ?? 0;
        const b = rgb[p + 2] ?? 0;
        blocks[0][k] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
        blocks[1][k] = -0.168736 * r - 0.331264 * g + 0.5 * b;
        blocks[2][k] = 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
      previous[0] = encodeBlock(blocks[0], previous[0] ?? 0, luma, out);
      previous[1] = encodeBlock(blocks[1], previous[1] ?? 0, chroma, out);
      previous[2] = encodeBlock(blocks[2], previous[2] ?? 0, chroma, out);
    }
  }

  const header = [
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0x00, ...ZIGZAG.map((n) => lumaQuant[n] ?? 1), 0x01, ...ZIGZAG.map((n) => chromaQuant[n] ?? 1)]),
    ...segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...segment(0xc4, [...huffmanSegment(0, 0, DC_LUMA), ...huffmanSegment(1, 0, AC_LUMA), ...huffmanSegment(0, 1, DC_CHROMA), ...huffmanSegment(1, 1, AC_CHROMA)]),
    ...segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]),
  ];
  const data = out.finish();
  const result = new Uint8Array(header.length + data.length + 2);
  result.set(header, 0);
  result.set(data, header.length);
  result.set([0xff, 0xd9], header.length + data.length);
  return result;
}
