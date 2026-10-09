// The public path of SC-20 without a browser: the body it sends and how it reads what the edge and the Bff
// answered (lib/public-signup.ts). The browser itself only runs against the deployed stage.
import { describe, expect, it } from "vitest";
import { CONSENTS_VERSION } from "@cuadrilla/shared/legal/consents";
import { startAnswerOf, startBody } from "./public-signup";

const QA = "success+qa-812-1-1@simulator.amazonses.com";

describe("SC-20's public signup.start [FL-104] [FL-113]", () => {
  it("[FL-104] sends the web's form: the QA address, both consents at the version in force, the UTM as attribution", () => {
    expect(JSON.parse(startBody({ email: QA, contactAccepted: true, utm: { utm_source: "qa" } }))).toEqual({
      email: QA,
      name: "Invitada QA",
      locale: "es-MX",
      consents: { TERMS_PRIVACY: { accepted: true, textVersion: CONSENTS_VERSION }, CONTACT: { accepted: true, textVersion: CONSENTS_VERSION } },
      attribution: { utm: { utm_source: "qa" } },
    });
    expect(JSON.parse(startBody({ email: QA }))).not.toHaveProperty("attribution");
  });

  it("[FL-104] starts QA addresses only: any other address never leaves the runner", () => {
    for (const email of ["ana.prueba@example.com", "success@simulator.amazonses.com", "success+qa-x@example.com"]) expect(() => startBody({ email })).toThrow(/QA addresses only/);
  });

  it("[FL-104] reads the procedure's result, the app's refusal with its reason, and the edge's own answers", () => {
    const result = { username: "gst-01K80000000000000000000001", ticket: "t", expiresAt: "2026-10-13T15:10:00.000Z" };
    expect(startAnswerOf(200, null, JSON.stringify({ result: { data: result } }))).toEqual({ ok: true, result });
    expect(startAnswerOf(429, null, JSON.stringify({ error: { message: "x", data: { code: "TOO_MANY_REQUESTS", reason: "RATE_LIMITED" } } }))).toEqual({ ok: false, status: 429, code: "TOO_MANY_REQUESTS", reason: "RATE_LIMITED" });
    expect(startAnswerOf(409, null, JSON.stringify({ error: { data: { code: "CONFLICT", reason: "EMAIL_TAKEN" } } }))).toMatchObject({ ok: false, reason: "EMAIL_TAKEN" });
    expect(startAnswerOf(202, "challenge", "<html></html>")).toEqual({ ok: false, status: 202, code: "WAF", reason: "CHALLENGE" });
    expect(startAnswerOf(403, null, "<html>blocked</html>")).toEqual({ ok: false, status: 403, code: "EDGE", reason: "HTTP_403" });
    expect(startAnswerOf(200, null, JSON.stringify({ result: { data: { username: "gst-x" } } }))).toMatchObject({ ok: false, code: "HTTP_200" });
  });
});
