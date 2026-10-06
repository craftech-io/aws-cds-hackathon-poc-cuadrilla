// What the certificate writer needs from a JPEG to embed it with `DCTDecode` (docs/architecture.md
// §11): its size and color components, read from the frame header with a bounded marker walk. The
// bytes themselves go into the PDF untouched; every evidence photo was already stored as a JPEG
// without metadata (evidence/strip-metadata.ts, docs/architecture.md §6), so nothing is re-encoded.

export interface JpegInfo {
  readonly width: number;
  readonly height: number;
  /** 1 gray, 3 RGB (YCbCr), 4 CMYK. */
  readonly components: 1 | 3 | 4;
}

export class InvalidJpegError extends Error {
  override readonly name = "InvalidJpegError";
}

/** Start-of-frame markers of baseline, extended and progressive Huffman JPEG (what `DCTDecode` reads). */
const FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2]);
/** Markers without a length field. */
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const MAX_SEGMENTS = 512;

function u16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

/** Size and components of a JPEG; throws `InvalidJpegError` for anything the PDF could not show. */
export function jpegInfo(bytes: Uint8Array): JpegInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new InvalidJpegError("not a JPEG (magic bytes)");
  let at = 2;
  for (let segment = 0; segment < MAX_SEGMENTS && at + 4 <= bytes.length; segment += 1) {
    if (bytes[at] !== 0xff) throw new InvalidJpegError("broken marker sequence");
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (STANDALONE.has(marker)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = u16(bytes, at + 2);
    if (length < 2 || at + 2 + length > bytes.length) throw new InvalidJpegError("segment past the end of the file");
    if (FRAME_MARKERS.has(marker)) {
      const precision = bytes[at + 4];
      const height = u16(bytes, at + 5);
      const width = u16(bytes, at + 7);
      const components = bytes[at + 9];
      if (precision !== 8) throw new InvalidJpegError("only 8-bit samples are embedded");
      if (width === 0 || height === 0) throw new InvalidJpegError("empty frame");
      if (components !== 1 && components !== 3 && components !== 4) throw new InvalidJpegError("unsupported color components");
      return { width, height, components };
    }
    at += 2 + length;
  }
  throw new InvalidJpegError("no frame header before the image data");
}
