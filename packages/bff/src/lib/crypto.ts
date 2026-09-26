// Secret-dependent primitives of the edge in one place: HKDF subkeys, HMACs, constant-time
// comparison, keyed ids, ULIDs and button nonces. Keys are always parameters (read once from
// `Resource` by lib/secrets.ts), so these functions stay pure and testable.
//
// `SessionTokenKey` is never used directly (docs/architecture.md §3): each purpose gets its own
// HKDF-SHA256 subkey with a fixed label, so a value leaked for one purpose (a simulated-envelope
// signature, a phone hash) says nothing about the others.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeEmail, normalizePhone } from "@cuadrilla/shared";

export type SecretKey = string | Uint8Array;

/** Fixed labels of the subkeys (HKDF `info`); changing one invalidates every value derived with it. */
export const SUBKEY_PURPOSES = ["session", "phone-hash", "email-hash", "nonce", "sim-envelope", "runtime-session", "media-key"] as const;
export type SubkeyPurpose = (typeof SUBKEY_PURPOSES)[number];

/** HKDF salt shared by every subkey of the app; public by design (RFC 5869 §3.1). */
export const SUBKEY_SALT = "aws-cds-hackathon-poc-cuadrilla/subkeys/v1";
export const SUBKEY_BYTES = 32;

/** HKDF-SHA256 (RFC 5869): extract with `salt`, expand with `info` to `length` bytes. */
export function hkdfSha256(ikm: SecretKey, salt: SecretKey, info: SecretKey, length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 1 || length > 255 * 32) throw new RangeError(`invalid HKDF length ${length}`);
  return new Uint8Array(hkdfSync("sha256", ikm, salt, info, length));
}

/** The subkey of one purpose. An empty master key is refused: every hash and signature would be public. */
export function deriveSubkey(master: SecretKey, purpose: SubkeyPurpose): Uint8Array {
  if (master.length === 0) throw new RangeError("the master key is empty");
  if (!SUBKEY_PURPOSES.includes(purpose)) throw new RangeError(`unknown subkey purpose "${String(purpose)}"`);
  return hkdfSha256(master, SUBKEY_SALT, purpose, SUBKEY_BYTES);
}

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

/** Checks a base64url HMAC-SHA256 of `message` in constant time (simulated envelope, signed links). */
export function verifyHmacBase64Url(key: SecretKey, message: string, signature: string): boolean {
  return safeEqual(signature, hmacSha256Base64Url(key, message));
}

/**
 * Keyed digest of a list of parts, hex. Each part is length-prefixed before hashing, so no choice
 * of separator inside a part (a clock id carries `#`) can make two different lists collide.
 */
export function keyedDigest(key: SecretKey, parts: ReadonlyArray<string | number>): string {
  const encoded = parts.map((part) => {
    const value = String(part);
    return `${Buffer.byteLength(value, "utf8")}:${value}`;
  });
  return hmacSha256Hex(key, encoded.join(""));
}

/**
 * `phoneHash` of `People GSI1` (`<clockId>#<phoneHash>`), `ADDR#` and `PHONELEASE#` (key: `phone-hash`
 * subkey): HMAC-SHA256 hex of the E.164 number, the same value `addressHash("WHATSAPP", …)` of
 * @cuadrilla/shared gives.
 */
export function phoneHash(phoneHashKey: SecretKey, rawPhone: string): string {
  return hmacSha256Hex(phoneHashKey, normalizePhone(rawPhone));
}

/** Hash of an email address (key: `email-hash` subkey), lower-cased and trimmed first. */
export function emailHash(emailHashKey: SecretKey, rawEmail: string): string {
  return hmacSha256Hex(emailHashKey, normalizeEmail(rawEmail));
}

export const RUNTIME_SESSION_ID_LENGTH = 48;

/** The session of a work order, or the day session of an installer without an active order. */
export type RuntimeSessionInput =
  | { readonly kind: "WORK_ORDER"; readonly workOrderId: string; readonly clockId: string; readonly worldEpoch: number; readonly sessionEpoch: number }
  | { readonly kind: "DAY"; readonly installerId: string; readonly simDate: string; readonly clockId: string; readonly worldEpoch: number };

function checkEpoch(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`invalid ${name} ${value}`);
}

function required(name: string, value: string): string {
  if (value === "") throw new RangeError(`${name} is required`);
  return value;
}

/**
 * `runtimeSessionId` of the Harness (docs/architecture.md §9.1): keyed digest with the
 * `runtime-session` subkey of the work order, its clock and both epochs (`"wo"` form), or of the
 * installer and the simulated date (`"day"` form, which also carries the clock and its epoch so a
 * reset never reuses a day session); first 48 hex characters. No phone or email ever enters the id.
 */
export function runtimeSessionId(runtimeSessionKey: SecretKey, input: RuntimeSessionInput): string {
  checkEpoch("worldEpoch", input.worldEpoch);
  const clockId = required("clockId", input.clockId);
  if (input.kind === "WORK_ORDER") {
    checkEpoch("sessionEpoch", input.sessionEpoch);
    const parts = ["wo", required("workOrderId", input.workOrderId), clockId, input.worldEpoch, input.sessionEpoch];
    return keyedDigest(runtimeSessionKey, parts).slice(0, RUNTIME_SESSION_ID_LENGTH);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.simDate)) throw new RangeError("simDate must be YYYY-MM-DD");
  const parts = ["day", required("installerId", input.installerId), input.simDate, clockId, input.worldEpoch];
  return keyedDigest(runtimeSessionKey, parts).slice(0, RUNTIME_SESSION_ID_LENGTH);
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
// for session ids, button nonces, turn ids and message ids without a dependency. The timestamp is
// real time by design: an id orders writes, it is not a business date.
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
