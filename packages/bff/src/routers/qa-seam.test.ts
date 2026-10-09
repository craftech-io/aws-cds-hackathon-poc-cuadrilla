// [W5 review B1] The QA seam's `signup.start` runs in the Bff on a direct invocation (routers/qa-seam.ts):
// the QaDriver's role may write neither the lead nor the run's counters. Only an event without
// `requestContext` takes this path, only for a QA address, and through the real procedure with the run's
// context: the lead is origin QA and every counter is the run's own.
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { createTestIssuer, functionUrlEvent, testContextDeps } from "../auth/testing";
import { leadEmailHash } from "../leads/keys";
import { EMAIL_HASH_KEY, signupForm, signupHarness } from "../signup/testing";
import { QA_SIGNUP_START, handleQaSeam, isQaSeamEvent } from "./qa-seam";
import { createSignupRouter } from "./signup";
import { createCallerFactory, createQaPublicContext, router } from "./trpc";

const QA_EMAIL = "success+qa-812-1-1@simulator.amazonses.com";
const request = (form: Record<string, unknown>, runId = "812-1") => ({ op: QA_SIGNUP_START, runId, correlationId: "812-1-sc-20-1-m1", form });

describe("the Bff's QA seam of signup.start [FL-104] [FL-113]", () => {
  it("is never a request of the Function URL: a viewer's body or headers cannot reach it", () => {
    expect(isQaSeamEvent(request(signupForm({ email: QA_EMAIL })))).toBe(true);
    const viewer = functionUrlEvent("/api/signup.start", { method: "POST", body: JSON.stringify(request(signupForm({ email: QA_EMAIL }))) });
    expect(isQaSeamEvent(viewer)).toBe(false);
    expect(isQaSeamEvent({ ...viewer, op: QA_SIGNUP_START })).toBe(false);
    expect(isQaSeamEvent({ op: "OTHER" })).toBe(false);
  });

  it("starts through the real procedure with the run's context: a QA lead and only the run's counters", async () => {
    const h = signupHarness();
    const deps = testContextDeps(createTestIssuer());
    const caller = createCallerFactory(router({ signup: createSignupRouter(() => h.ports()) }));
    const answer = await handleQaSeam(request(signupForm({ email: QA_EMAIL }), "812-1-s8"), (parsed) => caller(createQaPublicContext({ runId: parsed.runId, correlationId: parsed.correlationId }, deps)).signup.start(parsed.form));
    expect(answer).toMatchObject({ ok: true, result: { username: expect.stringMatching(/^gst-/), ticket: expect.any(String) } });
    expect((await h.leads.get(leadEmailHash(EMAIL_HASH_KEY, QA_EMAIL)))?.origin).toBe("QA");
    const counters = h.runtime.dump("Runtime").map((item) => item.PK);
    expect(counters.length).toBeGreaterThan(0);
    for (const pk of counters) expect(pk.startsWith("SIGNUP#qa-812-1-s8#")).toBe(true);
  });

  it("refuses an address that is not a QA one before anything runs, and a malformed request", async () => {
    let ran = 0;
    const start = async () => {
      ran += 1;
      return { ticket: "t", username: "gst-01K80000000000000000000001", expiresAt: "2026-10-13T15:10:00.000Z" };
    };
    expect(await handleQaSeam(request(signupForm({ email: "ana.prueba@example.com" })), start)).toEqual({ ok: false, error: expect.objectContaining({ code: "FORBIDDEN", reason: "NOT_A_QA_ADDRESS" }) });
    expect(await handleQaSeam({ ...request(signupForm({ email: QA_EMAIL })), extra: 1 }, start)).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(ran).toBe(0);
  });

  it("answers the procedure's refusal as its code and reason", async () => {
    const refused = await handleQaSeam(request(signupForm({ email: QA_EMAIL })), async () => {
      throw new TRPCError({ code: "CONFLICT", message: "taken", cause: new ToolError("CONFLICT", "there is already an account with this email", "EMAIL_TAKEN") });
    });
    expect(refused).toEqual({ ok: false, error: { code: "CONFLICT", message: "there is already an account with this email", reason: "EMAIL_TAKEN" } });
  });
});
