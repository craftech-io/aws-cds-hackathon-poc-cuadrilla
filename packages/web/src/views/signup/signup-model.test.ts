import { beforeEach, describe, expect, it } from "vitest";
import { CONSENTS_VERSION } from "@cuadrilla/shared/legal/consents";
import { principalFromIdToken } from "../../lib/auth-claims";
import { flowDeps } from "../../lib/auth/deps";
import { INITIAL_STATE, advance } from "../../lib/auth/flow";
import { createSrpClient } from "../../lib/auth/srp";
import { FAKE_POOL_ID, FakeCognito } from "../../lib/auth/testing/fake-cognito";
import { FakeSignupPool } from "../../lib/auth/testing/fake-signup";
import { WafTokenError } from "../../lib/waf-token";
import {
  INITIAL_SIGNUP,
  type SignupAction,
  type SignupDeps,
  type SignupFormValues,
  type SignupStartInput,
  type SignupState,
  advanceSignup,
  canSubmit,
  startInputOf,
} from "./signup-model";

// Fixture password of a fake pool; it only ever reaches the in-memory fakes.
const PASSWORD = "Fixture-Signup-1!";
const EMAIL = "ana.prueba@example.test";
const USERNAME = "gst-01K80000000000000000000001";

const FORM: SignupFormValues = { email: EMAIL, password: PASSWORD, name: "Ana Prueba", company: " ", jobTitle: "Coordinadora", terms: true, contact: false };

let pool: FakeCognito;
let signup: FakeSignupPool;
let starts: SignupStartInput[];
let startAnswer: () => Promise<{ ticket: string; username: string; expiresAt: string }>;
let wafReady: () => Promise<void>;
let now: number;

function deps(): SignupDeps {
  const login = flowDeps(pool, createSrpClient(FAKE_POOL_ID), { kind: "signIn" });
  return {
    start: async (input) => {
      starts.push(input);
      return startAnswer();
    },
    waf: { ready: () => wafReady() },
    cognito: signup,
    signIn: async (email, password) => {
      const result = await advance(INITIAL_STATE, { type: "signIn", email, password }, login);
      return result.state.step === "done" ? result.state.tokens : undefined;
    },
    now: () => now,
  };
}

const run = (state: SignupState, action: SignupAction) => advanceSignup(state, action, deps());
const submit = (form: SignupFormValues = FORM) => run(INITIAL_SIGNUP, { type: "submit", form, locale: "es-MX", attribution: { utm: { utm_source: "linkedin" }, referrer: "https://example.org" } });
const refusedBy = (reason: string) => () => Promise.reject(Object.assign(new Error(reason), { data: { code: "X", reason } }));

beforeEach(() => {
  pool = new FakeCognito();
  signup = new FakeSignupPool(pool);
  starts = [];
  now = Date.parse("2026-10-20T15:00:00.000Z");
  startAnswer = async () => ({ ticket: "ticket-1", username: USERNAME, expiresAt: new Date(now + 600_000).toISOString() });
  wafReady = async () => undefined;
});

describe("the sign-up form [FL-104] [FL-115]", () => {
  it("[FL-115] cannot be sent without TERMS_PRIVACY; CONTACT never blocks", async () => {
    expect(canSubmit({ email: EMAIL, terms: false })).toBe(false);
    expect(canSubmit({ email: EMAIL, terms: true })).toBe(true);
    expect(canSubmit({ email: "not-an-email", terms: true })).toBe(false);
    expect(await submit({ ...FORM, terms: false })).toEqual({ state: INITIAL_SIGNUP });
    expect(starts).toEqual([]);
    expect((await submit({ ...FORM, contact: false })).state.step).toBe("confirmCode");
  });

  it("[FL-104] checks the password against the pool's policy before spending a start", async () => {
    for (const password of ["short-1!A", "no-uppercase-123!", "NoSymbols12345", " Outer-Space-1!"]) {
      expect(await submit({ ...FORM, password })).toEqual({ state: INITIAL_SIGNUP, error: "WEAK_PASSWORD" });
    }
    expect(starts).toEqual([]);
    expect(signup.calls).toEqual([]);
  });

  it("[FL-115] sends the consents with their version in force, the language, the attribution, and never the password", async () => {
    await submit();
    expect(starts).toEqual([
      {
        email: EMAIL,
        name: "Ana Prueba",
        jobTitle: "Coordinadora",
        locale: "es-MX",
        consents: { TERMS_PRIVACY: { accepted: true, textVersion: CONSENTS_VERSION }, CONTACT: { accepted: false, textVersion: CONSENTS_VERSION } },
        attribution: { utm: { utm_source: "linkedin" }, referrer: "https://example.org" },
      },
    ]);
    expect(JSON.stringify(starts)).not.toContain(PASSWORD);
    expect(startInputOf({ ...FORM, name: "x".repeat(120) }, "en", undefined).name).toHaveLength(80);
  });

  it("[FL-104] SignUp uses the ticket's user and the ticket, in the language of the form", async () => {
    const answer = await run(INITIAL_SIGNUP, { type: "submit", form: FORM, locale: "en" });
    expect(answer.state).toMatchObject({ step: "confirmCode", account: { email: EMAIL, username: USERNAME } });
    expect(signup.calls).toEqual([{ operation: "SignUp", username: USERNAME, ticket: "ticket-1", locale: "en" }]);
  });
});

describe("refusals of the start and of Cognito [FL-113] [FL-114] [FL-121]", () => {
  it.each(["EMAIL_TAKEN", "RATE_LIMITED", "CAP_REACHED", "EMAIL_DOMAIN"] as const)("[FL-113] signup.start answering %s stays on the form with that message", async (reason) => {
    startAnswer = refusedBy(reason);
    expect(await submit()).toEqual({ state: INITIAL_SIGNUP, error: reason });
    expect(signup.calls).toEqual([]);
  });

  it("[FL-114] anything else of the start, or a network failure, is UNAVAILABLE; a missing WAF token is BROWSER_CHECK", async () => {
    startAnswer = refusedBy("NO_VIEWER");
    expect((await submit()).error).toBe("UNAVAILABLE");
    startAnswer = () => Promise.reject(new TypeError("Failed to fetch"));
    expect((await submit()).error).toBe("UNAVAILABLE");
    wafReady = () => Promise.reject(new WafTokenError("blocked"));
    expect(await submit()).toEqual({ state: INITIAL_SIGNUP, error: "BROWSER_CHECK" });
    expect(starts).toHaveLength(2);
  });

  it("[FL-121] the pre sign-up's refusals read as their own messages; a refused ticket needs a new start", async () => {
    for (const code of ["TICKET_INVALID", "EMAIL_TAKEN", "CAP_REACHED"]) {
      signup.refuseNextSignUp = code;
      expect(await submit()).toEqual({ state: INITIAL_SIGNUP, error: code });
    }
  });

  it("[FL-104] a SignUp lost on the network is retried with the same ticket; an expired ticket asks for a new start", async () => {
    signup.failNext = { operation: "SignUp", type: "network" };
    const failed = await submit();
    expect(failed.error).toBe("UNAVAILABLE");
    const retried = await run(failed.state, { type: "submit", form: FORM, locale: "es-MX" });
    expect(retried.state.step).toBe("confirmCode");
    expect(starts).toHaveLength(1);
    signup.failNext = { operation: "SignUp", type: "network" };
    const again = await submit({ ...FORM, email: "otra@example.test" });
    now += 600_000;
    await run(again.state, { type: "submit", form: { ...FORM, email: "otra@example.test" }, locale: "es-MX" });
    expect(starts).toHaveLength(3);
  });
});

describe("the code and the automatic sign-in [FL-105] [FL-106]", () => {
  async function toConfirm(): Promise<Extract<SignupState, { step: "confirmCode" }>> {
    const answer = await submit();
    if (answer.state.step !== "confirmCode") throw new Error("not on the code step");
    return answer.state;
  }

  it("[FL-105] a wrong or malformed code keeps the step; the right one confirms and signs in as a guest, without the password left anywhere", async () => {
    const confirm = await toConfirm();
    expect(await run(confirm, { type: "confirm", code: "12" })).toEqual({ state: confirm, error: "INVALID_CODE" });
    const wrong = signup.codeFor(EMAIL) === "111111" ? "222222" : "111111";
    expect(await run(confirm, { type: "confirm", code: wrong })).toMatchObject({ state: { step: "confirmCode" }, error: "INVALID_CODE" });
    const done = await run(confirm, { type: "confirm", code: signup.codeFor(EMAIL) });
    expect(done.state.step).toBe("done");
    if (done.state.step !== "done") return;
    expect(principalFromIdToken(done.state.tokens.idToken)).toMatchObject({ role: "GUEST", isGuest: true });
    expect(JSON.stringify(done.state)).not.toContain(PASSWORD);
    // The password proved itself by SRP: it never crossed the wire of the sign-in.
    for (const call of pool.calls) expect(call.payload).not.toContain(PASSWORD);
  });

  it("[FL-105] if the automatic sign-in does not work, the machine hands the email to the login", async () => {
    const confirm = await toConfirm();
    pool.failNext = { operation: "InitiateAuth", type: "NotAuthorizedException" };
    expect(await run(confirm, { type: "confirm", code: signup.codeFor(EMAIL) })).toEqual({ state: { step: "signIn", email: EMAIL } });
  });

  it("[FL-121] an email that became an alias of another account meanwhile is EMAIL_TAKEN", async () => {
    const confirm = await toConfirm();
    await pool.addUser({ email: EMAIL, password: "Other-Fixture-9$", role: "GUEST" });
    expect((await run(confirm, { type: "confirm", code: signup.codeFor(EMAIL) })).error).toBe("EMAIL_TAKEN");
  });

  it("[FL-106] resends the code, says so, and a throttled resend reads as too many attempts", async () => {
    const confirm = await toConfirm();
    const first = signup.codeFor(EMAIL);
    const resent = await run(confirm, { type: "resend" });
    expect(resent.state).toMatchObject({ step: "confirmCode", notice: "codeResent" });
    expect(signup.codeFor(EMAIL)).not.toBe(first);
    signup.failNext = { operation: "ResendConfirmationCode", type: "LimitExceededException" };
    expect((await run(confirm, { type: "resend" })).error).toBe("TOO_MANY_ATTEMPTS");
    signup.failNext = { operation: "ResendConfirmationCode", type: "UserLambdaValidationException" };
    expect((await run(confirm, { type: "resend" })).error).toBe("UNAVAILABLE");
  });

  it("[FL-105] 'Usar otro email' goes back to an empty form, and forgets the password", async () => {
    const confirm = await toConfirm();
    const back = await run(confirm, { type: "back" });
    expect(back).toEqual({ state: INITIAL_SIGNUP });
  });
});
