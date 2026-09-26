import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { functionUrlRegion, sigv4Transport } from "./sigv4";

const BASE = "https://abc123def.lambda-url.us-east-1.on.aws/";
const CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "session-token-example" };
const SIGNED_AT = new Date("2026-10-13T15:20:00Z");

function recordingFetch(response: () => Response = () => new Response('{"status":"ok"}', { status: 200, headers: { "Content-Type": "application/json", "Retry-After": "1" } })) {
  return vi.fn(async (_url: URL | string | Request, _init?: RequestInit) => response());
}

function sentHeaders(fetch: ReturnType<typeof recordingFetch>, call = 0): Record<string, string> {
  return (fetch.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
}

function signedHeaderNames(authorization: string | undefined): string[] {
  return /SignedHeaders=([^,]+)/.exec(authorization ?? "")?.[1]?.split(";") ?? [];
}

describe("SigV4 transport to a Function URL", () => {
  it("signs for lambda in the URL's region with the role's session credentials", async () => {
    const fetch = recordingFetch();
    const transport = sigv4Transport({ baseUrl: BASE, credentials: CREDENTIALS, fetch, now: () => SIGNED_AT });
    const signal = new AbortController().signal;
    const response = await transport({ method: "GET", path: "/v1/onus/DEMO3F2C19A0", headers: { "X-World": "JUDGE#isp-judge-07", "X-Caller": "HARNESS" } }, signal);
    expect(response).toEqual({ status: 200, headers: { "content-type": "application/json", "retry-after": "1" }, body: '{"status":"ok"}' });
    const headers = sentHeaders(fetch);
    expect(headers.authorization).toContain("Credential=AKIDEXAMPLE/20261013/us-east-1/lambda/aws4_request");
    expect(headers["x-amz-date"]).toBe("20261013T152000Z");
    expect(headers["x-amz-security-token"]).toBe("session-token-example");
    expect(signedHeaderNames(headers.authorization)).toEqual(expect.arrayContaining(["host", "x-amz-date", "x-amz-security-token", "x-caller", "x-world"]));
    // fetch derives Host from the URL, the same value that was signed.
    expect(headers.host).toBeUndefined();
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(signal);
  });

  it("signs the body of a world event and its content type", async () => {
    const fetch = recordingFetch();
    const transport = sigv4Transport({ baseUrl: BASE, credentials: CREDENTIALS, fetch, now: () => SIGNED_AT });
    const body = '{"kind":"INSTALLER_STEP"}';
    await transport({ method: "POST", path: "/v1/onus/DEMO3F2C19A0/physical-action", headers: { "X-World": "qa-812-1-sc-02" }, body }, new AbortController().signal);
    const headers = sentHeaders(fetch);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(body).digest("hex"));
    expect(signedHeaderNames(headers.authorization)).toEqual(expect.arrayContaining(["content-type", "x-amz-content-sha256"]));
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body });
  });

  it("changes the signature when the world changes: X-World is part of what is signed", async () => {
    const fetch = recordingFetch();
    const transport = sigv4Transport({ baseUrl: BASE, credentials: CREDENTIALS, fetch, now: () => SIGNED_AT });
    const request = (world: string) => transport({ method: "GET", path: "/v1/onus/DEMO3F2C19A0", headers: { "X-World": world } }, new AbortController().signal);
    await request("GLOBAL#isp-demo");
    await request("GLOBAL#isp-demo");
    await request("JUDGE#isp-judge-07");
    const signature = (call: number) => /Signature=([0-9a-f]{64})$/.exec(sentHeaders(fetch, call).authorization ?? "")?.[1];
    expect(signature(0)).toBe(signature(1));
    expect(signature(0)).not.toBe(signature(2));
  });

  it("accepts only https Function URLs and reads their region", () => {
    expect(functionUrlRegion(new URL(BASE))).toBe("us-east-1");
    expect(functionUrlRegion(new URL("https://x9y8z7.lambda-url.eu-west-3.on.aws"))).toBe("eu-west-3");
    expect(() => functionUrlRegion(new URL("https://example.com/"))).toThrow(RangeError);
    expect(() => sigv4Transport({ baseUrl: "http://abc123def.lambda-url.us-east-1.on.aws/", credentials: CREDENTIALS })).toThrow(RangeError);
  });
});
