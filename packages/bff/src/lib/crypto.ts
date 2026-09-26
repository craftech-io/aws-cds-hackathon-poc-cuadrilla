// Secret-dependent primitives of the edge in one place: HMACs, constant-time comparison, ULIDs and
// button nonces. Keys are always parameters (read once from `Resource` by lib/secrets.ts), so these
// functions stay pure. WP-12 adds the HKDF subkeys per purpose (docs/architecture.md §3: session,
// phone-hash, email-hash, nonce, sim-envelope, runtime-session, media-key).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SecretKey = string | Uint8Array;

export function sha256Hex(message: string | Uint8Array): string {
  return createHash("sha256").update(message).digest("hex");
}

export function hmacSha256Hex(key: SecretKey, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

/** 43 characters: an HMAC-SHA256 in base64url, the signature segment of a session token. */
export function hmacSha256Base64Url(key: SecretKey, message: string): string {
  return createHmac("sha256", key).update(message).digest("base64url");
}

// Constant-time comparison; a length mismatch is compared against itself so timing does not leak
// how many characters matched.
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: bigint, length: number): string {
  let remaining = value;
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out = (CROCKFORD[Number(remaining & 31n)] ?? "0") + out;
    remaining >>= 5n;
  }
  return out;
}

// ULID (48-bit millisecond timestamp + 80 random bits, Crockford base32, 26 chars): sortable ids
// for button nonces, turn ids and message ids without a dependency.
export function ulid(nowMs: number = Date.now(), random: (size: number) => Uint8Array = randomBytes): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) throw new RangeError(`ulid time out of range: ${nowMs}`);
  const entropy = random(10);
  if (entropy.length !== 10) throw new RangeError("ulid needs 10 bytes of entropy");
  let randomPart = 0n;
  for (const byte of entropy) randomPart = (randomPart << 8n) | BigInt(byte);
  return encodeBase32(BigInt(nowMs), 10) + encodeBase32(randomPart, 16);
}

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Opaque button nonce: the model and the installer only ever see this, never a payload. */
export function newNonce(nowMs?: number): string {
  return ulid(nowMs);
}

