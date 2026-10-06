import { describe, expect, it } from "vitest";
import { AC_CHROMA, AC_LUMA, DC_CHROMA, DC_LUMA, ZIGZAG, encodeJpeg, scaledQuant } from "./jpeg-encoder";
import { PngDecodeError, decodePng } from "./png";
import { JpegFormatError, isMetadataMarker, normalizeEvidencePhoto, stripJpegMetadata } from "./strip-metadata";
import { gradient, pngChunk, setPhoto, writePng } from "./testing";

/** Markers of a JPEG up to its start of scan. */
function markers(bytes: Uint8Array): number[] {
  const found: number[] = [];
  let offset = 2;
  while (offset < bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1] ?? 0;
    found.push(marker);
    if (marker === 0xda || marker === 0xd9) break;
    offset += 2 + (((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0));
  }
  return found;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return new Uint8Array([0xff, marker, length >> 8, length & 0xff, ...payload]);
}

/** ph-meter-01 with an EXIF block carrying a GPS position and a comment, right after SOI. */
function withExif(jpeg: Uint8Array): Uint8Array {
  const exif = segment(0xe1, new TextEncoder().encode("Exif\0\0MM\0*GPSLatitude 19.4326 N GPSLongitude 99.1332 W PhoneModel-X"));
  const comment = segment(0xfe, new TextEncoder().encode("taken by +52 55 0101 0001"));
  return new Uint8Array([...jpeg.subarray(0, 2), ...exif, ...comment, ...jpeg.subarray(2)]);
}

describe("the evidence copy of a JPEG loses its metadata (docs/architecture.md §6)", () => {
  it("removes EXIF with a GPS position, the comment and every APP1-APP15, and keeps JFIF and the image", () => {
    const original = setPhoto("ph-meter-01").bytes;
    const dirty = withExif(original);
    const { jpeg, removed } = stripJpegMetadata(dirty);
    expect(markers(jpeg).filter(isMetadataMarker)).toEqual([]);
    expect(removed).toBe(2 + markers(original).filter(isMetadataMarker).length);
    expect(new TextDecoder("latin1").decode(jpeg)).not.toMatch(/GPSLatitude|PhoneModel|0101 0001/);
    // The same photo without the added block strips to the same bytes: only metadata went away.
    expect(Buffer.from(jpeg).equals(Buffer.from(stripJpegMetadata(original).jpeg))).toBe(true);
    expect(jpeg[jpeg.length - 2]).toBe(0xff);
    expect(jpeg[jpeg.length - 1]).toBe(0xd9);
    expect(normalizeEvidencePhoto(dirty, "image/jpeg")).toMatchObject({ ok: true, converted: false, removedSegments: removed });
  });

  it("refuses a malformed JPEG instead of keeping it", () => {
    expect(() => stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0x00, 0x01]))).toThrow(JpegFormatError);
    expect(() => stripJpegMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toThrow(JpegFormatError);
    expect(normalizeEvidencePhoto(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), "image/jpeg")).toEqual({ ok: false, problem: "MALFORMED_JPEG" });
  });
});

describe("a live PNG becomes a JPEG, or gets the fixed notice", () => {
  it("decodes every filter type exactly: RGB, RGBA over white, gray with alpha and a palette", () => {
    const rgb = gradient(7, 10, 3);
    expect(Array.from(decodePng(writePng(7, rgb, 2)).rgb)).toEqual(rgb.flat());
    const rgba = rgb.map((row) => row.flatMap((value, i) => (i % 3 === 2 ? [value, 0xff] : [value]))).map((row, y) => row.map((value, i) => (i % 4 === 3 && y === 9 ? 0 : value)));
    const decoded = decodePng(writePng(7, rgba, 6)).rgb;
    expect(Array.from(decoded.subarray(0, 7 * 3))).toEqual(rgb[0]);
    expect(Array.from(decoded.subarray(9 * 7 * 3))).toEqual(new Array(21).fill(255));
    const grayAlpha = Array.from({ length: 3 }, () => [10, 255, 200, 255]);
    expect(Array.from(decodePng(writePng(2, grayAlpha, 4)).rgb)).toEqual(new Array(3).fill([10, 10, 10, 200, 200, 200]).flat());
    const palette = pngChunk("PLTE", new Uint8Array([255, 0, 0, 0, 0, 255]));
    const alpha = pngChunk("tRNS", new Uint8Array([255, 0]));
    expect(Array.from(decodePng(writePng(2, [[0, 1]], 3, [palette, alpha])).rgb)).toEqual([255, 0, 0, 255, 255, 255]);
  });

  it("converts a PNG into a baseline JPEG of the same size, without any metadata segment", () => {
    const png = writePng(21, gradient(21, 13, 3), 2);
    const normalized = normalizeEvidencePhoto(png, "image/png");
    expect(normalized).toMatchObject({ ok: true, converted: true });
    if (!normalized.ok) return;
    const { jpeg } = normalized;
    expect([jpeg[0], jpeg[1], jpeg[jpeg.length - 2], jpeg[jpeg.length - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect(markers(jpeg)).toEqual([0xe0, 0xdb, 0xc0, 0xc4, 0xda]);
    const sof = jpeg.indexOf(0xc0, 2) + 1;
    expect([((jpeg[sof + 3] ?? 0) << 8) | (jpeg[sof + 4] ?? 0), ((jpeg[sof + 5] ?? 0) << 8) | (jpeg[sof + 6] ?? 0)]).toEqual([13, 21]);
  });

  it("does not convert what it cannot decode: an interlaced PNG, a broken stream, a picture over the limit", () => {
    expect(normalizeEvidencePhoto(writePng(4, gradient(4, 4, 3), 2, [], 1), "image/png")).toEqual({ ok: false, problem: "PNG_NOT_CONVERTIBLE" });
    const broken = writePng(4, gradient(4, 4, 3), 2);
    broken.fill(0x41, 41, 60);
    expect(normalizeEvidencePhoto(broken, "image/png")).toEqual({ ok: false, problem: "PNG_NOT_CONVERTIBLE" });
    const huge = writePng(4, gradient(4, 4, 3), 2);
    huge.set([0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0xff, 0xff], 16);
    expect(() => decodePng(huge)).toThrow(PngDecodeError);
  });
});

describe("the JPEG encoder's tables (T.81 Annex K)", () => {
  it("uses Huffman tables that cover every symbol a baseline block can need", () => {
    for (const table of [DC_LUMA, DC_CHROMA, AC_LUMA, AC_CHROMA]) expect(table.counts.reduce((sum, count) => sum + count, 0)).toBe(table.symbols.length);
    // End of block, sixteen zeros, and every (run 0-15, size 1-10) pair.
    const acSymbols = new Set([0x00, 0xf0, ...Array.from({ length: 160 }, (_, k) => (Math.floor(k / 10) << 4) | ((k % 10) + 1))]);
    for (const table of [AC_LUMA, AC_CHROMA]) expect(new Set(table.symbols)).toEqual(acSymbols);
    expect([...ZIGZAG].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, k) => k));
  });

  it("scales the quantization like the IJG library and refuses impossible sizes", () => {
    expect(scaledQuant([16, 11, 255], 50)).toEqual([16, 11, 255]);
    expect(scaledQuant([16, 11, 99], 90)).toEqual([3, 2, 20]);
    expect(() => encodeJpeg({ width: 2, height: 2, rgb: new Uint8Array(3) })).toThrow(RangeError);
  });
});
