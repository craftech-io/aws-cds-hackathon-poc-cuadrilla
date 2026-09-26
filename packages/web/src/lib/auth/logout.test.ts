// "Salir" (FL-110, ADR-0025 §1): the refresh token is revoked at Cognito (`RevokeToken`, the
// `ConsoleWeb` client), the tokens leave the browser, and a revoked refresh token never renews the
// session again. The console calls `revokeSession` of tokens.ts from its session context.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCognitoApi } from "./cognito";
import { flowDeps } from "./deps";
import { INITIAL_STATE, advance } from "./flow";
import { createSrpClient } from "./srp";
import { FAKE_POOL_ID, FakeCognito } from "./testing/fake-cognito";
import { TOKENS_KEY, loadTokens, refreshTokens, revokeSession, saveTokens, type TokenSet } from "./tokens";

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
let pool: FakeCognito;
const PASSWORD = "Fixture-Logout-1!";

/** A guest of the own sign-up, signed in by SRP like the console does it. */
async function signedIn(): Promise<TokenSet> {
  await pool.addUser({ email: "invitada@example.test", password: PASSWORD, role: "GUEST", ispId: "isp-guest-s261020abcde" });
  const result = await advance(INITIAL_STATE, { type: "signIn", email: "invitada@example.test", password: PASSWORD }, flowDeps(pool, createSrpClient(FAKE_POOL_ID), { kind: "signIn" }));
  if (result.state.step !== "done") throw new Error("the fixture guest did not sign in");
  saveTokens(result.state.tokens);
  return result.state.tokens;
}

beforeEach(() => {
  storage = new MemoryStorage();
  Object.assign(globalThis, { sessionStorage: storage });
  pool = new FakeCognito();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

describe("sign-out [FL-110]", () => {
  it("[FL-110] revokes the refresh token at Cognito and clears the browser's copy", async () => {
    const tokens = await signedIn();
    expect(storage.items.has(TOKENS_KEY)).toBe(true);
    await revokeSession(pool, tokens);
    expect(pool.calls.map((call) => call.operation)).toContain("RevokeToken");
    expect(pool.revoked.has(tokens.refreshToken ?? "")).toBe(true);
    expect(storage.items.size).toBe(0);
    expect(loadTokens()).toBeUndefined();
  });

  it("[FL-110] the revoked refresh token never renews the session", async () => {
    const tokens = await signedIn();
    await revokeSession(pool, tokens);
    await expect(refreshTokens(pool, tokens)).rejects.toThrow(/revoked/);
    expect(loadTokens()).toBeUndefined();
  });

  it("[FL-110] revokes with the console's client id, with the token and nothing else", async () => {
    const sent: Array<{ target: string | null; body: unknown }> = [];
    const api = createCognitoApi({
      region: "us-east-1",
      clientId: "console-web-client",
      fetch: async (_input, init) => {
        sent.push({ target: new Headers(init?.headers).get("x-amz-target"), body: JSON.parse(String(init?.body)) });
        return new Response("{}", { status: 200 });
      },
    });
    await revokeSession(api, { idToken: "id", accessToken: "access", refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
    expect(sent).toEqual([{ target: "AWSCognitoIdentityProviderService.RevokeToken", body: { ClientId: "console-web-client", Token: "refresh-1" } }]);
  });

  it("[FL-110] signs out locally even when Cognito cannot be reached", async () => {
    const tokens = await signedIn();
    pool.failNext = { operation: "RevokeToken" };
    await revokeSession(pool, tokens);
    expect(storage.items.size).toBe(0);
  });
});
