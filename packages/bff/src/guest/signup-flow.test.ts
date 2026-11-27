// The own sign-up from the first call to the seeded world, in one process (ADR-0025, docs/test-plan.md
// §6.1 at level LF): `signup.start` through the router with the edge's viewer → pre sign-up with the
// ticket → the code confirmed (Cognito's part, the operator's QA seam on the stage) → post confirmation
// (account PHONE_PENDING) → sign-in (post authentication, pre token) → the session refused until it
// passes its SMS code (ADR-0029) → the code sent and checked through the `phone` router → the world
// asked for → `GuestWorlds` with the real guest template → `guest.world` answers READY with the world's
// people, and the lead carries the verified phone. Every port is the memory one of the tests.
import { describe, expect, it } from "vitest";
import { createTestIssuer, testContextDeps } from "../auth/testing";
import { decidePreSignUp } from "../auth-triggers/pre-sign-up";
import { decideTokenClaims, overrideDetails, resolveRegistryUser } from "../auth-triggers/pre-token";
import { handleGuestWorlds } from "../handlers/guest-worlds";
import { leadEmailHash } from "../leads/keys";
import { sequentialIds } from "../leads/testing";
import { createKillSwitchReader } from "../ops/kill-switch";
import { createMemoryRuntimeStore } from "../ops/memory-runtime-store";
import { memoryPhone } from "../phone/testing";
import { createGuestRouter } from "../routers/guest";
import { createPhoneRouter } from "../routers/phone";
import { createSignupRouter } from "../routers/signup";
import { createCallerFactory, createContextFactory, router } from "../routers/trpc";
import type { SignupPorts } from "../signup/start";
import { EMAIL_HASH_KEY, TEST_KEYS, TICKET_KEY, VIEWER_IP, fakeResolver, signupForm } from "../signup/testing";
import { getGuestAccount } from "./account";
import { CONFIRM_SIGNUP, confirmSignup } from "./confirmation";
import { SIGN_IN, ensureWorld, onSignIn } from "./sign-in";
import { guestHarness } from "./testing";

const issuer = createTestIssuer();
const EMAIL = "ana.prueba@example.com";
const SUB = "7f1c9d2e-0000-4000-8000-00000000a001";

describe("the own sign-up, end to end over memory [FL-104] [FL-106] [FL-107] [FL-108] [FL-123]", () => {
  it("signup.start → pre sign-up → confirmation → sign-in → SMS code → GuestWorlds → guest.world READY", async () => {
    const world = guestHarness();
    const kill = createKillSwitchReader({ store: createMemoryRuntimeStore(), ttlMs: 0 });
    const ids = sequentialIds("01K8");
    const ports: SignupPorts = { leads: world.leads.store, runtime: world.client, kill, keys: TEST_KEYS, resolver: fakeResolver(), now: world.now, newUlid: () => ids() };
    const phone = memoryPhone({ client: world.client, leads: world.leads.store, now: world.now, afterPass: async (principal) => void (await ensureWorld(world.signInDeps(), principal.sub)) });
    const contextDeps = testContextDeps(issuer, { connector: world.connector, phoneGate: phone.gate });
    const caller = createCallerFactory(
      router({
        signup: createSignupRouter(() => ports),
        guest: createGuestRouter(() => ({ client: world.client, connector: world.connector, provisioner: world.provisioner, now: world.now })),
        phone: createPhoneRouter(() => phone.ports),
      }),
    );
    const contextOf = createContextFactory(() => contextDeps);

    // 1. The form: a pending lead and a ticket bound to the email and the new user.
    const visitor = caller(await contextOf({ event: { headers: {} }, edge: { viewerIp: VIEWER_IP } }));
    const started = await visitor.signup.start(signupForm({ email: EMAIL }));
    expect(started.username).toMatch(/^gst-[0-9A-HJKMNP-TV-Z]{26}$/);

    // 2. Cognito's SignUp with the ticket in the client metadata: the pre sign-up trigger lets it through.
    const preSignUp = { runtime: world.client, leads: world.leads.store, kill, emailHashKey: () => EMAIL_HASH_KEY, ticketKey: () => TICKET_KEY, now: world.now, log: world.log };
    const signUpEvent = { triggerSource: "PreSignUp_SignUp", userName: started.username, request: { userAttributes: { email: EMAIL, locale: "es-MX" }, clientMetadata: { signupTicket: started.ticket } } };
    expect(await decidePreSignUp(preSignUp, signUpEvent)).toMatchObject({ kind: "SIGN_UP" });

    // 3. The code confirmed: the post confirmation trigger registers the guest; its world waits for the phone.
    const confirmed = await confirmSignup(world.confirmationDeps(), { triggerSource: CONFIRM_SIGNUP, userName: started.username, sub: SUB, email: EMAIL });
    expect(confirmed).toMatchObject({ kind: "CONFIRMED", status: "PHONE_PENDING" });
    if (confirmed.kind === "IGNORED") throw new Error("the confirmation was ignored");
    expect(world.provisioner.requests).toEqual([]);
    expect((await world.leads.store.get(leadEmailHash(EMAIL_HASH_KEY, EMAIL)))?.status).toBe("CONFIRMED");

    // 4. Sign-in: post authentication asks for nothing yet; the pre token trigger stamps the registry's claims.
    expect(await onSignIn(world.signInDeps(), { triggerSource: SIGN_IN, sub: SUB })).toMatchObject({ kind: "NONE", why: "AWAITING_PHONE_CODE" });
    const user = await resolveRegistryUser(world.connector.isps, SUB, async () => undefined);
    const decision = decideTokenClaims(user, undefined);
    expect(decision.kind).toBe("STAMP");
    const claims = overrideDetails(decision).idTokenGeneration?.claimsToAddOrOverride ?? {};
    expect(claims).toMatchObject({ userId: confirmed.userId, role: "GUEST", isGuest: "true" });
    const idToken = issuer.idToken({ sub: SUB, email: EMAIL, ...claims, "cognito:groups": ["GUEST"] });
    const guest = caller(await contextOf({ event: { headers: { authorization: `Bearer ${idToken}` } }, edge: { viewerIp: VIEWER_IP } }));

    // 5. Before the SMS code the session reaches nothing of the world; the sign-up's phone is prefilled.
    await expect(guest.guest.world()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await guest.phone.status()).toMatchObject({ state: "ENROL", phone: "+525501000001", codeSent: false });
    await guest.phone.sendCode({ locale: "es-MX" });
    expect(phone.sms.sent).toEqual([{ phone: "+525501000001", text: expect.stringMatching(/^Tu código de Cuadrilla es \d{6}\. Vence en 10 minutos\.$/) }]);
    expect(await guest.phone.verifyCode({ code: phone.sms.lastCode() ?? "" })).toMatchObject({ state: "PASSED" });
    expect(await world.leads.store.get(leadEmailHash(EMAIL_HASH_KEY, EMAIL))).toMatchObject({ phone: "+525501000001", phoneVerifiedAt: world.now().toISOString() });

    // 6. The pass asked for the world; GuestWorlds builds it from the guest template.
    expect(world.provisioner.requests).toEqual([{ userId: confirmed.userId, clockId: confirmed.clockId, origin: "SIGNUP" }]);
    const [request] = world.provisioner.requests;
    expect(await handleGuestWorlds({ client: world.client, factory: world.factoryDeps(), now: world.now, log: world.log }, request)).toEqual({ outcome: "READY" });
    expect((await getGuestAccount(world.client, confirmed.userId))?.status).toBe("READY");

    // 7. The guest's portada: its own seeded world, READY, with the account deletion offered.
    const view = await guest.guest.world();
    expect(view).toMatchObject({ status: "READY", origin: "SIGNUP", canDeleteAccount: true });
    expect(view.summary?.installers).toContain("Rogelio Méndez");
  });
});
