// ULIDs (https://github.com/ulid/spec): 48 bits of milliseconds and 80 bits of entropy in Crockford
// base32, 26 characters, sortable by time. The caller passes both halves: the time comes from the
// clock it was injected (never `Date.now()` in business logic, ADR-0010) and the entropy from Web
// Crypto in the Lambdas or from a seeded hash in the seed generator, whose `case-<ulid>` ids are
// deterministic (docs/seed-spec.md §2).
import { z } from "zod";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const ENTROPY_BYTES = 10;
const MAX_TIME = 2 ** 48 - 1;

/** Body of a ULID, for id patterns that embed one (`case-<ulid>`, `ev-<ulid>`, `val-<ulid>`). */
export const ULID_BODY = "[0-7][0-9A-HJKMNP-TV-Z]{25}";

export const Ulid = z.string().regex(new RegExp(`^${ULID_BODY}$`), "expected a ULID");
export type Ulid = z.infer<typeof Ulid>;

function encodeTime(timeMs: number): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME) throw new RangeError(`ULID time out of range: ${timeMs}`);
  let rest = timeMs;
  let out = "";
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    out = (ALPHABET[rest % 32] ?? "0") + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

// 80 bits → 16 characters of 5 bits, most significant first.
function encodeEntropy(entropy: Uint8Array): string {
  if (entropy.length !== ENTROPY_BYTES) throw new RangeError(`ULID entropy must be ${ENTROPY_BYTES} bytes, got ${entropy.length}`);
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of entropy) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31] ?? "0";
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** `encodeUlid(1469918176385, bytes)` → `01ARYZ6S41…`. */
export function encodeUlid(timeMs: number, entropy: Uint8Array): Ulid {
  return `${encodeTime(timeMs)}${encodeEntropy(entropy)}`;
}

/** Milliseconds encoded in the first 10 characters. */
export function ulidTime(ulid: string): number {
  return [...Ulid.parse(ulid).slice(0, TIME_LENGTH)].reduce((time, char) => time * 32 + ALPHABET.indexOf(char), 0);
}
