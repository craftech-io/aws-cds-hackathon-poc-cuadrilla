// The own sign-up from the first call to the seeded world, in one process (ADR-0025, docs/test-plan.md
// §6.1 at level LF): `signup.start` through the router with the edge's viewer → pre sign-up with the
// ticket → the code confirmed (Cognito's part, the operator's QA seam on the stage) → post confirmation
// → `GuestWorlds` with the real guest template → sign-in (post authentication, pre token) →
// `guest.world` answers READY with the world's people. Every port is the memory one of the tests.
import { describe, expect, it } from "vitest";
import { createTestIssuer, testContextDeps } from "../auth/testing";
import { decidePreSignUp } from "../auth-triggers/pre-sign-up";
import { decideTokenClaims, overrideDetails, resolveRegistryUser } from "../auth-triggers/pre-token";
import { handleGuestWorlds } from "../handlers/guest-worlds";
import { leadEmailHash } from "../leads/keys";
import { sequentialIds } from "../leads/testing";
import { createKillSwitchReader } from "../ops/kill-switch";
import { createMemoryRuntimeStore } from "../ops/memory-runtime-store";
import { createGuestRouter } from "../routers/guest";
import { createSignupRouter } from "../routers/signup";
import { createCallerFactory, createContextFactory, router } from "../routers/trpc";
import type { SignupPorts } from "../signup/start";
import { EMAIL_HASH_KEY, TEST_KEYS, TICKET_KEY, VIEWER_IP, fakeResolver, signupForm } from "../signup/testing";
import { getGuestAccount } from "./account";
import { CONFIRM_SIGNUP, confirmSignup } from "./confirmation";
import { SIGN_IN, onSignIn } from "./sign-in";
import { guestHarness } from "./testing";

const issuer = createTestIssuer();
const EMAIL = "ana.prueba@example.com";
const SUB = "7f1c9d2e-0000-4000-8000-00000000a001";

describe("the own sign-up, end to end over memory [FL-104] [FL-106] [FL-107] [FL-108]", () => {
  it("signup.start → pre sign-up → confirmation → GuestWorlds → sign-in → guest.world READY", async () => {
    const world = guestHarness();
    const kill = createKillSwitchReader({ store: createMemoryRuntimeStore(), ttlMs: 0 });
    const ids = sequentialIds("01K8");
    const ports: SignupPorts = { leads: world.leads.store, runtime: world.client, kill, keys: TEST_KEYS, resolver: fakeResolver(), now: world.now, newUlid: () => ids() };
    const contextDeps = testContextDeps(issuer, { connector: world.connector });
    const caller = createCallerFactory(
      router({
        signup: createSignupRouter(() => ports),
        guest: createGuestRouter(() => ({ client: world.client, connector: world.connector, provisioner: world.provisioner, now: world.now })),
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

    // 3. The code confirmed: the post confirmation trigger registers the guest and asks for its world.
    const confirmed = await confirmSignup(world.confirmationDeps(), { triggerSource: CONFIRM_SIGNUP, userName: started.username, sub: SUB, email: EMAIL });
    expect(confirmed).toMatchObject({ kind: "CONFIRMED", status: "PROVISIONING" });
    if (confirmed.kind === "IGNORED") throw new Error("the confirmation was ignored");
    expect(world.provisioner.requests).toEqual([{ userId: confirmed.userId, clockId: confirmed.clockId, origin: "SIGNUP" }]);
    expect((await world.leads.store.get(leadEmailHash(EMAIL_HASH_KEY, EMAIL)))?.status).toBe("CONFIRMED");

    // 4. GuestWorlds builds the world from the guest template.
    const [request] = world.provisioner.requests;
    expect(await handleGuestWorlds({ client: world.client, factory: world.factoryDeps(), now: world.now, log: world.log }, request)).toEqual({ outcome: "READY" });
    expect((await getGuestAccount(world.client, confirmed.userId))?.status).toBe("READY");

    // 5. Sign-in: post authentication keeps the ready world; the pre token trigger stamps the registry's claims.
    expect(await onSignIn(world.signInDeps(), { triggerSource: SIGN_IN, sub: SUB })).toMatchObject({ kind: "KEPT", userId: confirmed.userId });
    const user = await resolveRegistryUser(world.connector.isps, SUB, async () => undefined);
    const decision = decideTokenClaims(user, undefined);
    expect(decision.kind).toBe("STAMP");
    const claims = overrideDetails(decision).idTokenGeneration?.claimsToAddOrOverride ?? {};
    expect(claims).toMatchObject({ userId: confirmed.userId, role: "GUEST", isGuest: "true" });
    const idToken = issuer.idToken({ sub: SUB, ...claims, "cognito:groups": ["GUEST"] });

    // 6. The guest's portada: its own seeded world, READY, with the account deletion offered.
    const guest = caller(await contextOf({ event: { headers: { authorization: `Bearer ${idToken}` } } }));
    const view = await guest.guest.world();
    expect(view).toMatchObject({ status: "READY", origin: "SIGNUP", canDeleteAccount: true });
    expect(view.summary?.installers).toContain("Rogelio Méndez");
  });
});
