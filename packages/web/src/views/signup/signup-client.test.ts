import { describe, expect, it } from "vitest";
import { CONSENTS_VERSION } from "@cuadrilla/shared/legal/consents";
import { createWafToken } from "../../lib/waf-token";
import { createSignupClient } from "./signup-client";
import { type SignupStartInput, startErrorOf } from "./signup-model";

const INPUT: SignupStartInput = {
  email: "ana.prueba@example.test",
  locale: "es-MX",
  consents: { TERMS_PRIVACY: { accepted: true, textVersion: CONSENTS_VERSION }, CONTACT: { accepted: false, textVersion: CONSENTS_VERSION } },
};

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

/** The WAF-wrapped fetch the client is given: it records every request and answers like the BFF. */
function wafFetch() {
  const sent: Sent[] = [];
  let username = 0;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sent.push({ url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") });
    username += 1;
    const data = { ticket: `ticket-${username}`, username: `gst-01K8000000000000000000000${username}`, expiresAt: "2026-10-20T15:10:00.000Z" };
    return new Response(JSON.stringify({ result: { data } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, fetch };
}

describe("the sign-up's tRPC client [FL-114]", () => {
  it("[FL-114] two starts in the same tick are two POSTs to exactly /api/signup.start, never a batch, both through the WAF fetch", async () => {
    const waf = wafFetch();
    const client = createSignupClient({ fetch: waf.fetch });
    const [first, second] = await Promise.all([client.start(INPUT), client.start({ ...INPUT, email: "otra@example.test" })]);
    expect(first.username).not.toBe(second.username);
    expect(waf.sent).toHaveLength(2);
    for (const request of waf.sent) {
      expect(request.url).toBe("/api/signup.start");
      expect(request.method).toBe("POST");
      expect(request.url).not.toContain("batch");
      expect(request.url).not.toContain(",");
    }
    expect(JSON.parse(waf.sent[0]?.body ?? "{}")).toEqual(INPUT);
  });

  it("[FL-114] refuses an answer that is not a ticket of a gst- user", async () => {
    const client = createSignupClient({
      fetch: async () => new Response(JSON.stringify({ result: { data: { ticket: "t", username: "usr-admin", expiresAt: "x" } } }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(client.start(INPUT)).rejects.toThrow();
  });

  it("[FL-114] [SEC-2B-01] a start the edge still challenges reads as BROWSER_CHECK through tRPC's error, not UNAVAILABLE", async () => {
    const challenged = async (): Promise<Response> => new Response("<html></html>", { status: 202, headers: { "x-amzn-waf-action": "challenge", "content-type": "text/html" } });
    const waf = createWafToken({ integrationUrl: undefined, loadScript: async () => undefined, integration: () => undefined, fetch: challenged });
    const error: unknown = await createSignupClient(waf).start(INPUT).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeDefined();
    expect(startErrorOf(error)).toBe("BROWSER_CHECK");
  });
});
