import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groupSecret, looksLikeSignInId, missingPasswordRules, normalizeTotpCode, otpauthUri } from "./credentials";
import { TOKENS_KEY, isExpired, loadTokens, refreshTokens, restoreSession, revokeSession, safeReturnTo, saveTokens, type TokenSet } from "./tokens";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  Object.assign(globalThis, { sessionStorage: storage });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

const FRESH: TokenSet = { idToken: "id", accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 };

describe("token set in sessionStorage", () => {
  it("round-trips and rejects what is not a token set", () => {
    saveTokens(FRESH);
    expect(loadTokens()).toEqual(FRESH);
    storage.setItem(TOKENS_KEY, JSON.stringify({ idToken: "x" }));
    expect(loadTokens()).toBeUndefined();
  });

  it("treats a token about to expire as expired", () => {
    expect(isExpired({ ...FRESH, expiresAt: Date.now() + 10_000 })).toBe(true);
    expect(isExpired(FRESH)).toBe(false);
  });

  it("refreshes an expired session and keeps the refresh token", async () => {
    saveTokens({ ...FRESH, expiresAt: Date.now() - 1 });
    const cognito = { refresh: async () => ({ IdToken: "id-2", AccessToken: "access-2", ExpiresIn: 3600 }) };
    const restored = await restoreSession(cognito);
    expect(restored).toMatchObject({ idToken: "id-2", accessToken: "access-2", refreshToken: "refresh" });
    expect(loadTokens()).toEqual(restored);
  });

  it("drops a session whose refresh fails", async () => {
    saveTokens({ ...FRESH, expiresAt: Date.now() - 1 });
    const restored = await restoreSession({ refresh: async () => Promise.reject(new Error("revoked")) });
    expect(restored).toBeUndefined();
    expect(storage.items.size).toBe(0);
  });

  it("refuses to refresh without a refresh token", async () => {
    await expect(refreshTokens({ refresh: async () => Promise.reject(new Error("unused")) }, { idToken: "i", accessToken: "a", expiresAt: 0 })).rejects.toThrow();
  });

  it("clears locally and revokes the refresh token on sign-out, even offline", async () => {
    saveTokens(FRESH);
    const revoked: string[] = [];
    await revokeSession({ revoke: async (token) => void revoked.push(token) }, FRESH);
    expect(revoked).toEqual(["refresh"]);
    expect(loadTokens()).toBeUndefined();
    saveTokens(FRESH);
    await revokeSession({ revoke: async () => Promise.reject(new Error("offline")) }, FRESH);
    expect(loadTokens()).toBeUndefined();
  });
});

describe("safeReturnTo", () => {
  it("keeps same-origin paths and refuses the login route and other origins", () => {
    expect(safeReturnTo("/cases?x=1", "/login")).toBe("/cases?x=1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/login", "/login?returnTo=%2F", "", null, undefined]) {
      expect(safeReturnTo(bad, "/login", "/app/orders")).toBe("/app/orders");
    }
  });
});

describe("credentials helpers", () => {
  it("lists the password rules still missing", () => {
    expect(missingPasswordRules("abc")).toEqual(["length", "upper", "number", "symbol"]);
    expect(missingPasswordRules("Fixture-Password-1!")).toEqual([]);
  });

  it("[FL-079] signs in with an email or an invited account's username, nothing else", () => {
    for (const id of ["ana@example.test", " Ana@Example.test ", "guest-01", "Guest-07", "usr-ops-lina"]) expect(looksLikeSignInId(id), id).toBe(true);
    for (const id of ["", "  ", "ab", "guest 01", "-guest", "ana@", "<script>"]) expect(looksLikeSignInId(id), id).toBe(false);
  });

  it("accepts a six-digit code with spaces and nothing else", () => {
    expect(normalizeTotpCode("123 456")).toBe("123456");
    expect(normalizeTotpCode("12345")).toBeUndefined();
    expect(normalizeTotpCode("12345a")).toBeUndefined();
  });

  it("builds the otpauth URI authenticator apps scan", () => {
    const uri = new URL(otpauthUri("JBSWY3DPEHPK3PXP", "ana@example.test"));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/Cuadrilla:ana@example.test");
    expect(uri.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(uri.searchParams.get("issuer")).toBe("Cuadrilla");
    expect(uri.searchParams.get("digits")).toBe("6");
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
  });
});
