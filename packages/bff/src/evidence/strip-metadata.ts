// The copy of a photo that is kept as evidence (docs/architecture.md §6): a JPEG without metadata.
// EXIF can carry the GPS position and the device of the person who took it, so a JPEG loses every
// APP1-APP15 segment (EXIF, XMP, ICC, maker data) and every COM segment before it is stored; APP0
// (JFIF) and the image itself are copied byte for byte. A bounded marker walk: it stops at the start
// of scan, from where the entropy-coded data is copied as it is. A PNG (a live WhatsApp image) is
// decoded and encoded as JPEG; one that cannot be converted gets the fixed notice
// (`imageUnreadable`) and is never kept.
import { encodeJpeg } from "./jpeg-encoder";
import { decodePng } from "./png";

/** Quality of a PNG converted to JPEG: visually lossless for a photo of a label or a meter. */
export const PNG_TO_JPEG_QUALITY = 90;

export class JpegFormatError extends Error {
  override readonly name = "JpegFormatError";
}

// Markers without a length field: TEM and the restart markers RST0-RST7.
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const SOS = 0xda;
const EOI = 0xd9;
const COM = 0xfe;

/** APP1-APP15 and COM: the segments that carry metadata. */
export function isMetadataMarker(marker: number): boolean {
  return (marker >= 0xe1 && marker <= 0xef) || marker === COM;
}

export interface StrippedJpeg {
  readonly jpeg: Uint8Array;
  /** Segments removed (0 when the photo carried none). */
  readonly removed: number;
}

/** A JPEG without APP1-APP15 and COM; throws `JpegFormatError` on a malformed header. */
export function stripJpegMetadata(bytes: Uint8Array): StrippedJpeg {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new JpegFormatError("not a JPEG (missing SOI)");
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let removed = 0;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new JpegFormatError(`expected a marker at byte ${offset}`);
    let markerAt = offset + 1;
    // Fill bytes (0xFF) may precede a marker.
    while (bytes[markerAt] === 0xff) markerAt += 1;
    const marker = bytes[markerAt];
    if (marker === undefined) throw new JpegFormatError("truncated marker");
    if (marker === SOS || marker === EOI) {
      kept.push(bytes.subarray(markerAt - 1));
      return { jpeg: Buffer.concat(kept), removed };
    }
    if (STANDALONE.has(marker)) {
      kept.push(bytes.subarray(markerAt - 1, markerAt + 1));
      offset = markerAt + 1;
      continue;
    }
    const length = ((bytes[markerAt + 1] ?? 0) << 8) | (bytes[markerAt + 2] ?? 0);
    const end = markerAt + 1 + length;
    if (length < 2 || end > bytes.length) throw new JpegFormatError(`segment 0x${marker.toString(16)} runs past the end`);
    if (isMetadataMarker(marker)) removed += 1;
    else kept.push(bytes.subarray(markerAt - 1, end));
    offset = end;
  }
  throw new JpegFormatError("no start of scan");
}

export type NormalizedPhoto =
  | { readonly ok: true; readonly jpeg: Uint8Array; readonly converted: boolean; readonly removedSegments: number }
  | { readonly ok: false; readonly problem: "MALFORMED_JPEG" | "PNG_NOT_CONVERTIBLE" };

/** The evidence copy of a photo already typed by its magic bytes (checks.ts `precheckPhoto`). */
export function normalizeEvidencePhoto(bytes: Uint8Array, type: "image/jpeg" | "image/png"): NormalizedPhoto {
  try {
    if (type === "image/jpeg") {
      const { jpeg, removed } = stripJpegMetadata(bytes);
      return { ok: true, jpeg, converted: false, removedSegments: removed };
    }
    return { ok: true, jpeg: encodeJpeg(decodePng(bytes), PNG_TO_JPEG_QUALITY), converted: true, removedSegments: 0 };
  } catch {
    return { ok: false, problem: type === "image/jpeg" ? "MALFORMED_JPEG" : "PNG_NOT_CONVERTIBLE" };
  }
}
