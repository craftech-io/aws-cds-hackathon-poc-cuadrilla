import { describe, expect, it } from "vitest";
import { addressHash } from "@cuadrilla/shared";
import {
  RUNTIME_SESSION_ID_LENGTH,
  SUBKEY_PURPOSES,
  ULID_PATTERN,
  deriveSubkey,
  emailHash,
  hkdfSha256,
  hmacSha256Base64Url,
  keyedDigest,
  newNonce,
  phoneHash,
  runtimeSessionId,
  safeEqual,
  ulid,
  verifyHmacBase64Url,
} from "./crypto";

// Test-only master key; the stage key is 32 random bytes in base64 (`sst.Secret` SessionTokenKey).
const MASTER = "test-master-key-test-master-key-00000000";
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("HKDF subkeys", () => {
  it("implements HKDF-SHA256 as RFC 5869 test case 1", () => {
    const ikm = Buffer.alloc(22, 0x0b);
    const salt = Buffer.from("000102030405060708090a0b0c", "hex");
    const info = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex");
    expect(hex(hkdfSha256(ikm, salt, info, 42))).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
    expect(() => hkdfSha256(ikm, salt, info, 0)).toThrow(RangeError);
  });

  it("derives one stable 32-byte subkey per purpose of docs/architecture.md §3, all different and none equal to the master", () => {
    expect(SUBKEY_PURPOSES).toEqual(["session", "phone-hash", "email-hash", "nonce", "sim-envelope", "runtime-session", "media-key", "signup-ticket", "ip-hash"]);
    const subkeys = SUBKEY_PURPOSES.map((purpose) => hex(deriveSubkey(MASTER, purpose)));
    expect(new Set(subkeys).size).toBe(SUBKEY_PURPOSES.length);
    for (const subkey of subkeys) expect(subkey).toMatch(/^[0-9a-f]{64}$/);
    expect(subkeys).not.toContain(Buffer.from(MASTER).toString("hex"));
    expect(hex(deriveSubkey(MASTER, "session"))).toBe(subkeys[0]);
    expect(hex(deriveSubkey(`${MASTER}x`, "session"))).not.toBe(subkeys[0]);
  });

  it("refuses an empty master key and an unknown purpose", () => {
    expect(() => deriveSubkey("", "session")).toThrow(RangeError);
    expect(() => deriveSubkey(MASTER, "other" as never)).toThrow(RangeError);
    expect(() => deriveSubkey(MASTER, "signup" as never)).toThrow(RangeError);
  });

  it("gives the sign-up ticket and the IP hash subkeys of their own (ADR-0025 §3)", () => {
    const ticket = hex(deriveSubkey(MASTER, "signup-ticket"));
    const ip = hex(deriveSubkey(MASTER, "ip-hash"));
    expect(ticket).not.toBe(ip);
    for (const purpose of SUBKEY_PURPOSES.filter((name) => name !== "signup-ticket" && name !== "ip-hash")) {
      const other = hex(deriveSubkey(MASTER, purpose));
      expect(other, purpose).not.toBe(ticket);
      expect(other, purpose).not.toBe(ip);
    }
    const signed = hmacSha256Base64Url(deriveSubkey(MASTER, "signup-ticket"), "nonce|hash|gst-01|exp");
    expect(verifyHmacBase64Url(deriveSubkey(MASTER, "signup-ticket"), "nonce|hash|gst-01|exp", signed)).toBe(true);
    expect(verifyHmacBase64Url(deriveSubkey(MASTER, "session"), "nonce|hash|gst-01|exp", signed)).toBe(false);
  });
});

describe("address hashes", () => {
  const phoneKey = deriveSubkey(MASTER, "phone-hash");
  const emailKey = deriveSubkey(MASTER, "email-hash");

  it("hash the normalized address with its own subkey, as the shared addressHash does", async () => {
    expect(phoneHash(phoneKey, "+52 55 0900 0101")).toBe(phoneHash(phoneKey, "+525509000101"));
    expect(phoneHash(phoneKey, "+525509000101")).toBe(await addressHash("WHATSAPP", "+525509000101", phoneKey));
    expect(emailHash(emailKey, " Success+C10421@Simulator.AmazonSES.com ")).toBe(emailHash(emailKey, "success+c10421@simulator.amazonses.com"));
    expect(emailHash(emailKey, "a@simulator.amazonses.com")).toBe(await addressHash("EMAIL", "a@simulator.amazonses.com", emailKey));
  });

  it("separate purposes: the same value under two subkeys gives two hashes", () => {
    expect(phoneHash(phoneKey, "+525509000101")).not.toBe(phoneHash(emailKey, "+525509000101"));
    expect(() => phoneHash(phoneKey, "12")).toThrow(RangeError);
  });
});

describe("keyed digests and runtimeSessionId", () => {
  const key = deriveSubkey(MASTER, "runtime-session");
  const workOrder = { kind: "WORK_ORDER", workOrderId: "wo-24817", clockId: "GLOBAL#isp-demo", worldEpoch: 1, sessionEpoch: 0 } as const;
  const day = { kind: "DAY", installerId: "inst-rogelio", simDate: "2026-10-13", clockId: "GLOBAL#isp-demo", worldEpoch: 1 } as const;

  it("length-prefixes every part, so moving a separator never collides", () => {
    expect(keyedDigest(key, ["a#b", "c"])).not.toBe(keyedDigest(key, ["a", "b#c"]));
    expect(keyedDigest(key, ["ab", "c"])).not.toBe(keyedDigest(key, ["a", "bc"]));
    expect(keyedDigest(key, ["wo", 1])).toBe(keyedDigest(key, ["wo", "1"]));
  });

  it("is 48 characters the Harness accepts, stable, with no phone or email in it", () => {
    const id = runtimeSessionId(key, workOrder);
    expect(id).toHaveLength(RUNTIME_SESSION_ID_LENGTH);
    expect(id).toMatch(/^[0-9a-f]{48}$/);
    expect(runtimeSessionId(key, workOrder)).toBe(id);
    expect(runtimeSessionId(key, day)).toHaveLength(RUNTIME_SESSION_ID_LENGTH);
  });

  it("changes with the world epoch, the session epoch, the clock, the order and the key", () => {
    const ids = [
      runtimeSessionId(key, workOrder),
      runtimeSessionId(key, { ...workOrder, worldEpoch: 2 }),
      runtimeSessionId(key, { ...workOrder, sessionEpoch: 1 }),
      runtimeSessionId(key, { ...workOrder, clockId: "GUEST#isp-guest-07" }),
      runtimeSessionId(key, { ...workOrder, workOrderId: "wo-24818" }),
      runtimeSessionId(deriveSubkey(MASTER, "session"), workOrder),
      runtimeSessionId(key, day),
      runtimeSessionId(key, { ...day, simDate: "2026-10-14" }),
      runtimeSessionId(key, { ...day, worldEpoch: 2 }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses negative epochs, missing ids and a malformed date", () => {
    expect(() => runtimeSessionId(key, { ...workOrder, worldEpoch: -1 })).toThrow(RangeError);
    expect(() => runtimeSessionId(key, { ...workOrder, sessionEpoch: 0.5 })).toThrow(RangeError);
    expect(() => runtimeSessionId(key, { ...workOrder, workOrderId: "" })).toThrow(RangeError);
    expect(() => runtimeSessionId(key, { ...day, simDate: "13/10/2026" })).toThrow(RangeError);
  });
});

describe("tokens and ids", () => {
  it("generates sortable ULIDs and nonces", () => {
    const zeros = (size: number) => new Uint8Array(size);
    expect(ulid(0, zeros)).toBe("0".repeat(26));
    expect(ulid(1_000, zeros) < ulid(2_000, zeros)).toBe(true);
    expect(newNonce()).toMatch(ULID_PATTERN);
    expect(newNonce()).not.toBe(newNonce());
    expect(() => ulid(-1)).toThrow(RangeError);
  });

  it("signs in base64url and verifies in constant time", () => {
    const key = deriveSubkey(MASTER, "sim-envelope");
    const signature = hmacSha256Base64Url(key, '{"clockId":"GUEST#isp-guest-07"}');
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyHmacBase64Url(key, '{"clockId":"GUEST#isp-guest-07"}', signature)).toBe(true);
    expect(verifyHmacBase64Url(key, '{"clockId":"GLOBAL#isp-demo"}', signature)).toBe(false);
    expect(verifyHmacBase64Url(deriveSubkey(MASTER, "session"), '{"clockId":"GUEST#isp-guest-07"}', signature)).toBe(false);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
