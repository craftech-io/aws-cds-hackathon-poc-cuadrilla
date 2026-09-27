import type { PreSignUpTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { leadEmailHash } from "../leads/keys";
import { createLogger } from "../lib/log";
import { EMAIL_HASH_KEY, SIGNUP_T0, TICKET_KEY, type SignupHarness, signupForm, signupHarness } from "../signup/testing";
import { SIGNUP_TICKET_TTL_MS, issueTicket } from "../signup/ticket";
import { startSignup } from "../signup/start";
import { type PreSignUpDeps, createPreSignUpHandler } from "./pre-sign-up";

const EMAIL = "ana.prueba@example.com";

function signUpEvent(userName: string, ticket: string | undefined, attributes: Record<string, string> = {}, triggerSource = "PreSignUp_SignUp"): PreSignUpTriggerEvent {
  return {
    version: "1",
    region: "us-east-1",
    userPoolId: "us-east-1_TESTPOOL1",
    userName,
    callerContext: { awsSdkVersion: "3", clientId: "guest-signup-client" },
    triggerSource,
    request: { userAttributes: { email: EMAIL, locale: "es-MX", ...attributes }, ...(ticket === undefined ? {} : { clientMetadata: { signupTicket: ticket } }) },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  } as PreSignUpTriggerEvent;
}

describe("pre sign-up trigger [FL-104] [FL-114] [FL-121] [FL-122]", () => {
  let h: SignupHarness;
  let lines: string[];
  let ticket: string;
  let username: string;

  const deps = (): PreSignUpDeps => ({
    runtime: h.runtime,
    leads: h.leads,
    kill: h.ports().kill,
    emailHashKey: () => EMAIL_HASH_KEY,
    ticketKey: () => TICKET_KEY,
    now: () => h.now(),
    log: createLogger({ sink: (line) => void lines.push(line) }),
  });
  const handler = () => createPreSignUpHandler(() => deps(), () => createLogger({ sink: (line) => void lines.push(line) }));
  const refusalOf = async (event: PreSignUpTriggerEvent): Promise<string> => {
    try {
      await handler()(event);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "ACCEPTED";
  };
  const runtimeKeys = () => h.runtime.dump("Runtime").map((item) => item.PK);

  beforeEach(async () => {
    h = signupHarness();
    lines = [];
    const started = await startSignup(() => h.ports(), { input: signupForm({ email: EMAIL }), edge: { viewerIp: "203.0.113.10" }, qa: null, log: createLogger({ sink: () => undefined }) });
    ticket = started.ticket;
    username = started.username;
  });

  it("[FL-104] a SignUp with the ticket of its start passes, never confirms nor verifies, and spends one use", async () => {
    const before = runtimeKeys();
    const event = await handler()(signUpEvent(username, ticket));
    expect(event.response).toEqual({ autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false });
    // [FL-112] only the ticket's row is new: no counter was incremented.
    expect(runtimeKeys().filter((key) => !before.includes(key))).toEqual([expect.stringMatching(/^SIGNUPTICKET#/)]);
    expect(h.runtime.dump("Runtime").filter((item) => item.PK.startsWith("SIGNUP#")).map((item) => item.used)).toEqual(before.filter((key) => key.startsWith("SIGNUP#")).map(() => 1));
    expect(lines.join("\n")).not.toContain(EMAIL);
  });

  it("[FL-114] a second use for the same user passes; a third one is TICKET_INVALID", async () => {
    expect(await refusalOf(signUpEvent(username, ticket))).toBe("ACCEPTED");
    expect(await refusalOf(signUpEvent(username, ticket))).toBe("ACCEPTED");
    expect(await refusalOf(signUpEvent(username, ticket))).toBe("TICKET_INVALID");
  });

  it("[FL-114] without a ticket, expired, for another email, for another user or with a bad signature → TICKET_INVALID", async () => {
    expect(await refusalOf(signUpEvent(username, undefined))).toBe("TICKET_INVALID");
    expect(await refusalOf(signUpEvent("gst-01K80000000000000000000099", ticket))).toBe("TICKET_INVALID");
    expect(await refusalOf(signUpEvent(username, ticket, { email: "otra.persona@example.com" }))).toBe("TICKET_INVALID");
    expect(await refusalOf(signUpEvent(username, `${ticket.slice(0, -3)}AAA`))).toBe("TICKET_INVALID");
    const forged = issueTicket("another-key-another-key-another-key-00", { nonce: "01K80000000000000000000077", emailHash: leadEmailHash(EMAIL_HASH_KEY, EMAIL), username, exp: Math.floor(SIGNUP_T0.getTime() / 1000) + 600 });
    expect(await refusalOf(signUpEvent(username, forged))).toBe("TICKET_INVALID");
    h.advance(SIGNUP_TICKET_TTL_MS);
    expect(await refusalOf(signUpEvent(username, ticket))).toBe("TICKET_INVALID");
    expect(runtimeKeys().some((key) => key.startsWith("SIGNUPTICKET#"))).toBe(false);
  });

  it("[FL-121] an email whose lead is CONFIRMED → EMAIL_TAKEN", async () => {
    await h.leads.confirm({ emailHash: leadEmailHash(EMAIL_HASH_KEY, EMAIL), username, sub: "sub-ana", userId: "usr-g01K80000000000000000000009", at: SIGNUP_T0 });
    expect(await refusalOf(signUpEvent(username, ticket))).toBe("EMAIL_TAKEN");
  });

  it("[FL-114] a person who confirmed two accounts since the start (another address) → RATE_LIMITED, reading only", async () => {
    const lead = await h.leads.get(leadEmailHash(EMAIL_HASH_KEY, EMAIL));
    const key = { PK: `SIGNUPKEY#${lead?.abuseHash ?? ""}`, SK: "META" };
    await h.runtime.put("Runtime", { ...key, entity: "SignupKey", confirmedAccounts: 1 });
    expect(await refusalOf(signUpEvent(username, ticket))).toBe("ACCEPTED");
    await h.runtime.update("Runtime", key, { confirmedAccounts: 2 }, SIGNUP_T0.toISOString());
    expect(await refusalOf(signUpEvent(username, ticket))).toBe("RATE_LIMITED");
    expect((await h.runtime.get("Runtime", key))?.confirmedAccounts).toBe(2);
  });

  it("[FL-122] a custom:* attribute or a locale outside {es-MX, en} is refused", async () => {
    expect(await refusalOf(signUpEvent(username, ticket, { "custom:ispId": "isp-demo" }))).toBe("ATTRIBUTE_NOT_ALLOWED");
    expect(await refusalOf(signUpEvent(username, ticket, { "custom:role": "SUPERVISOR" }))).toBe("ATTRIBUTE_NOT_ALLOWED");
    expect(await refusalOf(signUpEvent(username, ticket, { locale: "pt-BR" }))).toBe("LOCALE_NOT_ALLOWED");
    expect(await refusalOf(signUpEvent(username, ticket, { locale: "en" }))).toBe("ACCEPTED");
  });

  it("[FL-122] denies by default: any other trigger source is refused; AdminCreateUser passes without a ticket", async () => {
    for (const source of ["PreSignUp_ExternalProvider", "PreSignUp_MigrateUser", "PostConfirmation_ConfirmSignUp"]) {
      expect(await refusalOf(signUpEvent(username, ticket, {}, source))).toBe("SOURCE_NOT_ALLOWED");
    }
    const invited = await handler()(signUpEvent("guest-07", undefined, { "custom:ispId": "isp-guest-07" }, "PreSignUp_AdminCreateUser"));
    expect(invited.response).toEqual({ autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false });
  });

  it("[FL-112] the cut of the sign-up (KILL#SIGNUP, KILL#ALL) and a day over its cap → CAP_REACHED, reading only", async () => {
    await h.cut("SIGNUP");
    expect(await refusalOf(signUpEvent(username, ticket))).toBe("CAP_REACHED");
    h = signupHarness();
    const started = await startSignup(() => h.ports(), { input: signupForm({ email: EMAIL }), edge: { viewerIp: "203.0.113.10" }, qa: null, log: createLogger({ sink: () => undefined }) });
    await h.cut("ALL");
    expect(await refusalOf(signUpEvent(started.username, started.ticket))).toBe("CAP_REACHED");
    h = signupHarness();
    const again = await startSignup(() => h.ports(), { input: signupForm({ email: EMAIL }), edge: { viewerIp: "203.0.113.10" }, qa: null, log: createLogger({ sink: () => undefined }) });
    const day = `SIGNUP#GLOBAL#${SIGNUP_T0.toISOString().slice(0, 10)}`;
    // The 300th start of the day still completes its SignUp; a day over the cap takes no more.
    await h.runtime.update("Runtime", { PK: day, SK: "META" }, { used: 300 }, SIGNUP_T0.toISOString());
    expect(await refusalOf(signUpEvent(again.username, again.ticket))).toBe("ACCEPTED");
    await h.runtime.update("Runtime", { PK: day, SK: "META" }, { used: 301 }, SIGNUP_T0.toISOString());
    expect(await refusalOf(signUpEvent(again.username, again.ticket))).toBe("CAP_REACHED");
    expect((await h.runtime.get("Runtime", { PK: day, SK: "META" }))?.used).toBe(301);
  });
});
