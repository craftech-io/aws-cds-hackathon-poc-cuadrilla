// Minimal JPEG header reader: the magic bytes and the frame size from the first SOF marker. Enough
// for the datasheet and the tests to check format and dimensions without an image library.

export interface JpegInfo {
  readonly width: number;
  readonly height: number;
  /** APP1 (EXIF, XMP) or COM segments: the renders carry none. Chromium's sRGB ICC profile (APP2) is allowed. */
  readonly exifOrCommentSegments: number;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Walks the markers up to the start of scan; throws on anything that is not a well-formed JPEG header. */
export function jpegInfo(bytes: Uint8Array): JpegInfo {
  if (!isJpeg(bytes)) throw new RangeError("not a JPEG (missing FF D8 FF)");
  let offset = 2;
  let exifOrCommentSegments = 0;
  let size: { width: number; height: number } | undefined;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new RangeError(`bad marker at ${offset}`);
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd9 || marker === 0xda) break;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (marker === 0xe1 || marker === 0xfe) exifOrCommentSegments += 1;
    if (SOF_MARKERS.has(marker) && size === undefined) {
      size = { height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0), width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0) };
    }
    offset += 2 + length;
  }
  if (size === undefined) throw new RangeError("JPEG without a frame header");
  return { ...size, exifOrCommentSegments };
}
