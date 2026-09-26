// A bounded reader of Ogg/Opus files (RFC 3533, RFC 7845): walks the pages, checks each page's
// CRC, reads the OpusHead header (channels, pre-skip) and computes the duration from the last
// granule position. Used by `seed:voices` to write the datasheet and by voices.test.ts to check it.

export interface OggOpusInfo {
  readonly pages: number;
  readonly channels: number;
  readonly preSkip: number;
  /** Seconds of audio: (last granule − pre-skip) / 48000. */
  readonly durationSec: number;
}

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  return crc >>> 0;
});

function pageCrc(bytes: Uint8Array, start: number, length: number): number {
  let crc = 0;
  for (let i = 0; i < length; i += 1) {
    // The CRC field (bytes 22-25 of the page) counts as zero.
    const byte = i >= 22 && i < 26 ? 0 : (bytes[start + i] ?? 0);
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
  }
  return crc;
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0;
}

export function isOgg(bytes: Uint8Array): boolean {
  return bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
}

/** Parses the whole file; throws on a bad capture pattern, a bad CRC or a missing OpusHead. */
export function oggOpusInfo(bytes: Uint8Array, maxPages = 100_000): OggOpusInfo {
  if (!isOgg(bytes)) throw new RangeError("not an Ogg file (missing OggS)");
  let offset = 0;
  let pages = 0;
  let lastGranule = 0;
  let head: { channels: number; preSkip: number } | undefined;
  while (offset < bytes.length) {
    if (pages >= maxPages) throw new RangeError("too many Ogg pages");
    if (!isOgg(bytes.subarray(offset, offset + 4))) throw new RangeError(`bad capture pattern at ${offset}`);
    const segments = bytes[offset + 26] ?? 0;
    let bodyLength = 0;
    for (let i = 0; i < segments; i += 1) bodyLength += bytes[offset + 27 + i] ?? 0;
    const pageLength = 27 + segments + bodyLength;
    if (offset + pageLength > bytes.length) throw new RangeError(`truncated page at ${offset}`);
    if (pageCrc(bytes, offset, pageLength) !== u32(bytes, offset + 22)) throw new RangeError(`bad CRC in page ${pages}`);
    const granuleLow = u32(bytes, offset + 6);
    const granuleHigh = u32(bytes, offset + 10);
    if (granuleLow !== 0xffffffff || granuleHigh !== 0xffffffff) lastGranule = granuleHigh * 2 ** 32 + granuleLow;
    const body = offset + 27 + segments;
    if (pages === 0) {
      const magic = String.fromCharCode(...bytes.subarray(body, body + 8));
      if (magic !== "OpusHead") throw new RangeError("first page is not OpusHead");
      head = { channels: bytes[body + 9] ?? 0, preSkip: (bytes[body + 10] ?? 0) | ((bytes[body + 11] ?? 0) << 8) };
    }
    offset += pageLength;
    pages += 1;
  }
  if (head === undefined) throw new RangeError("no OpusHead");
  return { pages, channels: head.channels, preSkip: head.preSkip, durationSec: Math.max(0, lastGranule - head.preSkip) / 48_000 };
}
