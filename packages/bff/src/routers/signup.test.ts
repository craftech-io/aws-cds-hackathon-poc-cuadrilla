import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { type TestContextDeps, createTestIssuer, functionUrlEvent, testContextDeps, testLambdaContext, trpcResponse } from "../auth/testing";
import { signupKeyKey } from "../leads/guest-accounts";
import { leadAbuseHash, leadEmailHash } from "../leads/keys";
import { EMAIL_HASH_KEY, SIGNUP_T0, TICKET_KEY, VIEWER_IP, type FakeDomain, type SignupHarness, signupForm, signupHarness } from "../signup/testing";
import { readTicket } from "../signup/ticket";
import { createHandler } from "./handler";
import { createSignupRouter } from "./signup";
import { type EdgeContext, createCallerFactory, createContextFactory, createQaPublicContext, router } from "./trpc";

const issuer = createTestIssuer();
const HOUR = 3_600_000;
const ORIGIN_KEY = "k7Qm2Xv9Rt4Lp8Zc1Nw6Hy3Bf5Dj0Gs+Ae/UoKiW2xE=";

interface Refusal {
  readonly code: string;
  readonly reason: string | undefined;
  readonly message: string;
}

async function refusalOf(call: Promise<unknown>): Promise<Refusal> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    return { code: error.code, reason: error.cause instanceof ToolError ? error.cause.reason : undefined, message: error.message };
  }
  throw new Error("expected a refusal");
}

describe("signup.start [FL-104] [FL-112] [FL-113] [FL-115] [FL-121]", () => {
  let h: SignupHarness;
  let deps: TestContextDeps;
  const setup = (domains: Readonly<Record<string, FakeDomain>> = {}) => {
    h = signupHarness(domains);
    deps = testContextDeps(issuer);
  };
  const caller = () => createCallerFactory(router({ signup: createSignupRouter(() => h.ports()) }));
  const asViewer = async (edge: EdgeContext | null) => caller()(await createContextFactory(() => deps)({ event: { headers: {} }, ...(edge === null ? {} : { edge }) }));
  const start = async (form: Record<string, unknown> = signupForm(), edge: EdgeContext | null = { viewerIp: VIEWER_IP }) => (await asViewer(edge)).signup.start(form);
  const counters = () => h.runtime.dump("Runtime").map((item) => item.PK);

  beforeEach(() => setup());

  it("[FL-104] a valid start: a pending lead with the new gst-<ULID> user, and a ticket bound to the email hash and that user", async () => {
    const answer = await start();
    expect(answer.username).toMatch(/^gst-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Date.parse(answer.expiresAt) - SIGNUP_T0.getTime()).toBeLessThanOrEqual(10 * 60_000);
    const emailHash = leadEmailHash(EMAIL_HASH_KEY, "ana.prueba@example.com");
    const read = readTicket(TICKET_KEY, answer.ticket, SIGNUP_T0);
    expect(read).toMatchObject({ ok: true, ticket: { emailHash, username: answer.username } });
    const lead = await h.leads.get(emailHash);
    expect(lead).toMatchObject({ pendingUsernames: [answer.username], origin: "WEB", locale: "es-MX", name: "Ana Prueba" });
    expect(lead?.status).toBeUndefined();
    // [FL-115] consents with their version, the attribution reduced (a bad UTM dropped, the referrer's origin only).
    expect(lead?.consents.TERMS_PRIVACY).toMatchObject({ accepted: true, textVersion: expect.any(String), locale: "es-MX" });
    expect(lead?.consents.CONTACT.accepted).toBe(false);
    expect(lead?.utm).toEqual({ source: "linkedin", campaign: "fibra-2026" });
    expect(lead?.referrerOrigin).toBe("https://example.org");
    expect(deps.lines.join("\n")).toContain('"metric":"SignupStarted"');
  });

  it("[FL-104] refuses a field it does not know (an origin, a password) or a missing one, naming the field only", async () => {
    for (const extra of [{ origin: "QA" }, { password: "Aa1-secret-password" }]) {
      const refusal = await refusalOf(start(signupForm({ extra })));
      expect(refusal).toMatchObject({ code: "BAD_REQUEST", reason: "INVALID_FORM" });
      expect(refusal.message).not.toContain("secret");
    }
    const { email: _email, ...withoutEmail } = signupForm();
    expect(await refusalOf(start(withoutEmail))).toMatchObject({ reason: "INVALID_FORM", message: expect.stringContaining("email") });
    expect(counters()).toEqual([]);
    expect(h.leadTable.leads.size).toBe(0);
  });

  it("[FL-115] an old version of a consent, or TERMS_PRIVACY not accepted, is INVALID and writes nothing", async () => {
    expect(await refusalOf(start(signupForm({ version: "2025-01-01" })))).toMatchObject({ code: "BAD_REQUEST", reason: expect.stringMatching(/^CONSENT_TERMS_PRIVACY_STALE_VERSION$/) });
    expect(await refusalOf(start(signupForm({ terms: false })))).toMatchObject({ code: "BAD_REQUEST", reason: "CONSENT_TERMS_PRIVACY_REQUIRED" });
    expect(counters()).toEqual([]);
    expect(h.leadTable.leads.size).toBe(0);
  });

  it("[FL-104] the email's domain: no MX, A or AAAA and a null MX are INVALID without a lead; only A passes; a slow resolver passes with SignupMxUnknown", async () => {
    setup({
      "nowhere.example": {},
      "nullmx.example": { mx: [{ exchange: "", priority: 0 }] },
      "only-a.example": { a: ["192.0.2.7"] },
      "slow.example": { delayMs: 1_500 },
      "broken.example": { fail: "ESERVFAIL" },
    });
    expect(await refusalOf(start(signupForm({ email: "ana@nowhere.example" })))).toMatchObject({ code: "BAD_REQUEST", reason: "EMAIL_DOMAIN" });
    expect(await refusalOf(start(signupForm({ email: "ana@nullmx.example" })))).toMatchObject({ reason: "EMAIL_DOMAIN" });
    expect(h.leadTable.leads.size).toBe(0);
    expect(counters()).toEqual([]);
    await expect(start(signupForm({ email: "ana@only-a.example" }))).resolves.toMatchObject({ username: expect.any(String) });
    await expect(start(signupForm({ email: "ana@slow.example" }))).resolves.toMatchObject({ username: expect.any(String) });
    await expect(start(signupForm({ email: "ana@broken.example" }))).resolves.toMatchObject({ username: expect.any(String) });
    expect(deps.lines.filter((line) => line.includes('"metric":"SignupMxUnknown"'))).toHaveLength(2);
  });

  it("[FL-113] the sixth start from one IP in an hour is RATE_LIMITED; the next hour starts over", async () => {
    for (let n = 1; n <= 5; n += 1) await start(signupForm({ email: `persona${n}@example.com` }));
    expect(await refusalOf(start(signupForm({ email: "persona6@example.com" })))).toMatchObject({ code: "TOO_MANY_REQUESTS", reason: "RATE_LIMITED" });
    expect(await refusalOf(start(signupForm({ email: "persona6@example.com" })))).toMatchObject({ reason: "RATE_LIMITED" });
    expect(h.leadTable.leads.size).toBe(5);
    await expect(start(signupForm({ email: "persona6@example.com" }), { viewerIp: "198.51.100.20" })).resolves.toBeDefined();
    h.advance(HOUR);
    await expect(start(signupForm({ email: "persona7@example.com" }))).resolves.toBeDefined();
    expect(deps.lines.join("\n")).toContain('"metric":"SignupRejected"');
  });

  it("[FL-113] from an IP that AWS WAF labelled anonymous, the second start of the hour is RATE_LIMITED", async () => {
    const anonymous = { viewerIp: "192.0.2.44", anonymousIp: true };
    await start(signupForm({ email: "uno@example.com" }), anonymous);
    expect(await refusalOf(start(signupForm({ email: "dos@example.com" }), anonymous))).toMatchObject({ reason: "RATE_LIMITED" });
    expect(counters().some((pk) => pk.startsWith("SIGNUP#ANONDAY#"))).toBe(true);
  });

  it("[FL-113] one person is one person: me+1@gmail.com, m.e@gmail.com, me@googlemail.com and me@gmail.com; two simulator tags are two people", async () => {
    const ips = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"];
    const aliases = ["me+1@gmail.com", "m.e@gmail.com", "me@googlemail.com", "me@gmail.com"];
    for (const [index, email] of aliases.slice(0, 3).entries()) await start(signupForm({ email }), { viewerIp: ips[index] ?? VIEWER_IP });
    expect(await refusalOf(start(signupForm({ email: aliases[3] }), { viewerIp: "198.51.100.9" }))).toMatchObject({ reason: "RATE_LIMITED" });
    // Two more in the next hour make five in the day; the sixth of the day is refused.
    h.advance(HOUR);
    await start(signupForm({ email: "me+2@gmail.com" }), { viewerIp: "198.51.100.5" });
    await start(signupForm({ email: "me+3@gmail.com" }), { viewerIp: "198.51.100.6" });
    h.advance(HOUR);
    expect(await refusalOf(start(signupForm({ email: "me+4@gmail.com" }), { viewerIp: "198.51.100.7" }))).toMatchObject({ reason: "RATE_LIMITED" });
    // The mailbox simulator keeps its tags: every one of them is another person.
    for (let n = 1; n <= 4; n += 1) await start(signupForm({ email: `success+qa-tag${n}@simulator.amazonses.com` }), { viewerIp: `192.0.2.${n}` });
    expect(leadAbuseHash(EMAIL_HASH_KEY, "success+qa-a@simulator.amazonses.com")).not.toBe(leadAbuseHash(EMAIL_HASH_KEY, "success+qa-b@simulator.amazonses.com"));
  });

  it("[FL-113] a fourth unconfirmed user for the same email is RATE_LIMITED; the pending lead keeps its first start", async () => {
    const first = await start();
    h.advance(HOUR);
    const second = await start(signupForm({ contact: true }));
    const emailHash = leadEmailHash(EMAIL_HASH_KEY, "ana.prueba@example.com");
    const lead = await h.leads.get(emailHash);
    expect(lead?.pendingUsernames).toEqual([first.username, second.username]);
    expect(lead?.signupStartedAt).toBe(SIGNUP_T0.toISOString());
    expect(lead?.consents.CONTACT.accepted).toBe(true);
    h.advance(HOUR);
    await start();
    h.advance(HOUR);
    expect(await refusalOf(start())).toMatchObject({ reason: "RATE_LIMITED" });
    expect((await h.leads.get(emailHash))?.pendingUsernames).toHaveLength(3);
  });

  it("[FL-113] a person with two confirmed accounts gets RATE_LIMITED for a third", async () => {
    const abuseHash = leadAbuseHash(EMAIL_HASH_KEY, "tercera@gmail.com");
    await h.runtime.put("Runtime", { ...signupKeyKey(abuseHash), entity: "SignupKey", confirmedAccounts: 2 });
    expect(await refusalOf(start(signupForm({ email: "ter.cera@gmail.com" })))).toMatchObject({ reason: "RATE_LIMITED" });
    expect(h.leadTable.leads.size).toBe(0);
  });

  it("[FL-112] the day's cap of starts and the cut of the sign-up (KILL#SIGNUP or KILL#ALL) answer CAP_REACHED", async () => {
    const day = `SIGNUP#GLOBAL#${SIGNUP_T0.toISOString().slice(0, 10)}`;
    await h.runtime.put("Runtime", { PK: day, SK: "META", entity: "SignupCounter", used: 300 });
    expect(await refusalOf(start())).toMatchObject({ code: "TOO_MANY_REQUESTS", reason: "CAP_REACHED" });
    expect(h.leadTable.leads.size).toBe(0);
    setup();
    await h.cut("SIGNUP");
    expect(await refusalOf(start())).toMatchObject({ reason: "CAP_REACHED" });
    setup();
    await h.cut("ALL");
    expect(await refusalOf(start())).toMatchObject({ reason: "CAP_REACHED" });
    expect(counters()).toEqual([]);
  });

  it("[FL-121] an email with a confirmed account is EMAIL_TAKEN, and no lead or user is added", async () => {
    const answer = await start();
    const emailHash = leadEmailHash(EMAIL_HASH_KEY, "ana.prueba@example.com");
    await h.leads.confirm({ emailHash, username: answer.username, sub: "sub-ana", userId: "usr-g01K80000000000000000000009", at: SIGNUP_T0 });
    h.advance(HOUR);
    expect(await refusalOf(start(signupForm({ email: "Ana.Prueba@Example.com" })))).toMatchObject({ code: "CONFLICT", reason: "EMAIL_TAKEN" });
    expect((await h.leads.get(emailHash))?.pendingUsernames).toEqual([answer.username]);
  });

  it("[FL-114] without the edge's viewer and without a QA run: UNAVAILABLE, no lead, no ticket, no counter", async () => {
    expect(await refusalOf(start(signupForm(), null))).toMatchObject({ code: "SERVICE_UNAVAILABLE", reason: "NO_VIEWER" });
    const context = await createContextFactory(() => deps)({ event: { headers: {} } });
    expect(await refusalOf(caller()(context).signup.start(signupForm()))).toMatchObject({ reason: "NO_VIEWER" });
    expect(counters()).toEqual([]);
    expect(h.leadTable.leads.size).toBe(0);
  });

  it("[FL-113] a call of the QaDriver counts under SIGNUP#qa-<runId>#…, never under the public keys", async () => {
    const qa = caller()(createQaPublicContext({ runId: "812-1" }, deps));
    await qa.signup.start(signupForm({ email: "success+qa-sc20-1@simulator.amazonses.com" }));
    expect(counters().length).toBeGreaterThan(0);
    for (const pk of counters()) expect(pk.startsWith("SIGNUP#qa-812-1#")).toBe(true);
    const lead = await h.leads.get(leadEmailHash(EMAIL_HASH_KEY, "success+qa-sc20-1@simulator.amazonses.com"));
    expect(lead?.origin).toBe("QA");
  });

  it("[FL-114] signup.start is a mutation: a GET never runs it and writes nothing", async () => {
    const handler = createHandler(router({ signup: createSignupRouter(() => h.ports()) }), createContextFactory(() => deps));
    const input = encodeURIComponent(JSON.stringify(signupForm()));
    const response = trpcResponse(await handler(functionUrlEvent("/api/signup.start", { query: `input=${input}` }), testLambdaContext));
    expect(response.status).toBe(405);
    expect(response.body.error?.data.code).toBe("METHOD_NOT_SUPPORTED");
    expect(counters()).toEqual([]);
    expect(h.leadTable.leads.size).toBe(0);
  });

  it("[FL-115] the IP and the email are never in clear in Runtime nor in the logs", async () => {
    await start();
    const stored = JSON.stringify(h.runtime.dump("Runtime"));
    for (const clear of [VIEWER_IP, "ana.prueba@example.com", "@"]) expect(stored).not.toContain(clear);
    expect(deps.lines.join("\n")).not.toContain("ana.prueba");
    expect(deps.lines.join("\n")).not.toContain(VIEWER_IP);
  });

  it("[FL-104] an invalid request with an email: neither the logs, the error body nor the metrics carry an address", async () => {
    const handler = createHandler(router({ signup: createSignupRouter(() => h.ports()) }), createContextFactory(() => deps), {
      edge: { originKey: () => ORIGIN_KEY, log: () => deps.loggerFor("edge") },
    });
    const bodies: string[] = [];
    for (const form of [signupForm({ email: "victima@example.com", extra: { origin: "QA" } }), { email: "victima@example.com", locale: "xx" }, signupForm({ email: "no-es-un-email@" })]) {
      const event = functionUrlEvent("/api/signup.start", {
        method: "POST",
        body: JSON.stringify(form),
        headers: { "x-cuadrilla-origin": ORIGIN_KEY, "cloudfront-viewer-address": `${VIEWER_IP}:46532`, "content-type": "application/json" },
      });
      const response = await handler(event, testLambdaContext);
      expect(response.statusCode).toBe(400);
      bodies.push(String(response.body));
    }
    for (const text of [...bodies, ...deps.lines]) expect(text).not.toMatch(/[^\s"]+@[^\s"]*/);
    expect(bodies.join("\n")).toContain("INVALID_FORM");
    expect(h.leadTable.leads.size).toBe(0);
  });
});
