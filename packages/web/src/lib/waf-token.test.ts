import { describe, expect, it } from "vitest";
import { WAF_TOKEN_TIMEOUT_MS, type WafIntegration, WafTokenError, challengeScriptUrl, createWafToken } from "./waf-token";

const URL_OF_ACL = "https://abc123.us-east-1.sdk.awswaf.com/abc123/def456/";

function fakeIntegration(options: { tokenFails?: boolean } = {}) {
  const fetched: string[] = [];
  const integration: WafIntegration = {
    getToken: () => (options.tokenFails ? Promise.reject(new Error("challenge failed")) : Promise.resolve("token-1")),
    fetch: async (input) => {
      fetched.push(String(input));
      return new Response("{}", { status: 200 });
    },
  };
  return { integration, fetched };
}

describe("the AWS WAF token of the sign-up [FL-114]", () => {
  it("[FL-114] loads challenge.js from the ACL's integration URL once, gets the token, and sends through the SDK's fetch", async () => {
    const loaded: string[] = [];
    const { integration, fetched } = fakeIntegration();
    let installed: WafIntegration | undefined;
    const plain: string[] = [];
    const waf = createWafToken({
      integrationUrl: URL_OF_ACL,
      loadScript: async (src) => {
        loaded.push(src);
        installed = integration;
      },
      integration: () => installed,
      fetch: async (input) => {
        plain.push(String(input));
        return new Response("{}");
      },
    });
    await waf.ready();
    await waf.fetch("/api/signup.start", { method: "POST" });
    await waf.fetch("/api/signup.start", { method: "POST" });
    expect(loaded).toEqual([`${URL_OF_ACL}challenge.js`]);
    expect(fetched).toEqual(["/api/signup.start", "/api/signup.start"]);
    expect(plain).toEqual([]);
  });

  it("[FL-114] a blocked script or a failed challenge is BROWSER_CHECK, never an unhandled error; a later attempt may work", async () => {
    let block = true;
    const { integration } = fakeIntegration();
    const waf = createWafToken({
      integrationUrl: URL_OF_ACL,
      loadScript: async () => {
        if (block) throw new Error("blocked by an extension");
      },
      integration: () => (block ? undefined : integration),
      fetch: async () => new Response("{}"),
    });
    await expect(waf.ready()).rejects.toBeInstanceOf(WafTokenError);
    await expect(waf.fetch("/api/signup.start")).rejects.toMatchObject({ code: "BROWSER_CHECK" });
    block = false;
    await expect(waf.ready()).resolves.toBeUndefined();
    const failing = createWafToken({ integrationUrl: URL_OF_ACL, loadScript: async () => undefined, integration: () => fakeIntegration({ tokenFails: true }).integration, fetch: async () => new Response("{}") });
    await expect(failing.ready()).rejects.toBeInstanceOf(WafTokenError);
  });

  it("[FL-114] gives up after its deadline (10 s in the browser) when the SDK never shows up", async () => {
    expect(WAF_TOKEN_TIMEOUT_MS).toBe(10_000);
    const waf = createWafToken({ integrationUrl: URL_OF_ACL, loadScript: async () => undefined, integration: () => undefined, fetch: async () => new Response("{}"), timeoutMs: 60, pollMs: 5 });
    await expect(waf.ready()).rejects.toBeInstanceOf(WafTokenError);
  });

  it("where no web ACL fronts the app there is no token to get: ready at once, plain fetch", async () => {
    const plain: string[] = [];
    const waf = createWafToken({ integrationUrl: undefined, loadScript: async () => Promise.reject(new Error("never")), integration: () => undefined, fetch: async (input) => ((plain.push(String(input)), new Response("{}"))) });
    await expect(waf.ready()).resolves.toBeUndefined();
    await waf.fetch("/api/signup.start");
    expect(plain).toEqual(["/api/signup.start"]);
    expect(challengeScriptUrl("https://x.sdk.awswaf.com/a/b")).toBe("https://x.sdk.awswaf.com/a/b/challenge.js");
  });
});
