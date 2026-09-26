// crypto and deadline.
import { describe, expect, it } from "vitest";
import { ULID_PATTERN, hmacSha256Base64Url, hmacSha256Hex, newNonce, safeEqual, sha256Hex, ulid } from "./crypto";
import { DeadlineError, withDeadline } from "./deadline";

const KEY = "stage-secret-stage-secret-stage-secret";

describe("crypto", () => {
  it("generates sortable ULIDs and nonces", () => {
    const zeros = (size: number) => new Uint8Array(size);
    expect(ulid(0, zeros)).toBe("0".repeat(26));
    expect(ulid(Date.parse("2026-10-14T13:30:00Z"), zeros)).toMatch(ULID_PATTERN);
    expect(ulid(1_000, zeros) < ulid(2_000, zeros)).toBe(true);
    expect(newNonce()).toMatch(ULID_PATTERN);
    expect(newNonce()).not.toBe(newNonce());
    expect(() => ulid(-1)).toThrow(RangeError);
  });

  it("signs with HMAC-SHA256 and compares in constant time", () => {
    expect(hmacSha256Base64Url(KEY, "a.b.1")).toHaveLength(43);
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("deadline", () => {
  it("returns the result when the call finishes in time", async () => {
    expect(await withDeadline("network.getOnuStatus", 1_000, async () => "ok")).toBe("ok");
  });

  it("aborts and throws a retryable DeadlineError when it does not", async () => {
    let aborted = false;
    const slow = withDeadline("network.getOnuStatus", 10, (signal) => new Promise<string>((resolve) => { signal.addEventListener("abort", () => { aborted = true; }); setTimeout(() => resolve("late"), 200); }));
    await expect(slow).rejects.toBeInstanceOf(DeadlineError);
    await expect(slow).rejects.toMatchObject({ operation: "network.getOnuStatus", timeoutMs: 10, retryable: true });
    expect(aborted).toBe(true);
    await expect(withDeadline("x", 0, async () => 1)).rejects.toThrow(RangeError);
  });
});
