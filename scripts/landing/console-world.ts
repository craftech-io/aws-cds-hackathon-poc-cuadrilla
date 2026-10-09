// The world the capture pipeline shows (capture-console.ts), and the base of the local UI server of the
// console's specs (tests/ui-server/): the real BFF over an in-memory connector seeded only from
// scripts/seed/data, and a throwaway token issuer whose keys exist only in this process. The BFF
// verifies every request with its real verifier against this issuer; nothing here accepts an unsigned
// token and nothing here ships in a Lambda.
//
//   visitor       nobody is signed in: the landing, the signup form and its code step
//   guest-ready   a guest of the own signup, signed in, with a world of the `guest` template that is
//                 ready (clock paused at 07:00 of the story's day, nothing pending)
//   guest-scene   the console of the local UI server (tests/ui-server/app.ts: the real router, the real
//                 world factory, the S3 emulator) with the rehearsal guest's world loaded in a scene of
//                 the tour ("Saltar a escena", WP-39) and holding the main story up to one entry
//                 (story-thread.ts, story-mail.ts): the moments of the landing's walkthrough
//
// Every state runs the neutral brand: this process has no BrandConfig, so the partner's name or logo
// can never reach a versioned picture (ADR-0018). The local overrides with real phones and addresses
// are never read, and the only addresses a frame may show are the synthetic visitor's, on a domain
// reserved for examples, the masked ones of the world's simulated mailboxes and the product's senders.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GUEST_TEST_CLOCK_ID } from "@cuadrilla/shared";
import { createUiApp } from "../../tests/ui-server/app";
import { TEST_POOL, type TestIssuer, createTestIssuer, testContextDeps } from "../../packages/bff/src/auth/testing";
import { type MemoryConnector, createMemoryConnector } from "../../packages/bff/src/connector/index";
import { accountItem } from "../../packages/bff/src/guest/account";
import { maskEmail } from "@cuadrilla/shared";
import { deriveSubkey, phoneHash } from "../../packages/bff/src/lib/crypto";
import { createLogger } from "../../packages/bff/src/lib/log";
import { scheduledTimers } from "../../packages/bff/src/clock/state";
import type { Connector } from "../../packages/bff/src/connector/ports";
import { bindConsolePorts } from "../../packages/bff/src/routers/console-ports";
import { memoryConsolePorts } from "../../packages/bff/src/routers/console-testing";
import { createQaCaller } from "../../packages/bff/src/routers/index";
import { readWorldClock } from "../../packages/bff/src/timers/timers";
import { buildWorld } from "../../packages/bff/src/worlds/factory";
import type { CaptureSpec, SceneSetup } from "./captures";
import { type ApiHandler, apiHandler } from "./console-server";
import { seedStoryEvidence } from "./story-evidence";
import { CAPTURE_EMAIL_DOMAIN, seedStoryMail } from "./story-mail";
import { sceneStory, seedStoryThread, storyIds } from "./story-thread";

export { TEST_POOL };

/** The story's day at 07:00 in Mexico City: the real clock of every capture world. */
export const CAPTURE_NOW = new Date("2026-10-13T13:00:00.000Z");

/** The visitor who signs up in the captures: a synthetic address on a domain reserved for examples. */
export const VISITOR = { email: "prueba@example.com" } as const;

/** The operator of the capture guest's world: a signup generation of the story's day (`isp-guest-s<yymmdd><5 base32>`). */
export const GUEST_ISP = "isp-guest-s261013landg";

/** The rehearsal guest's world of the local UI server: the world "Saltar a escena" loads (`GUEST#isp-guest-test`). */
export const SCENE_ISP = "isp-guest-test";

/** Who is signed in for a capture, as the pre-token trigger would stamp it. */
export interface Signer {
  readonly sub: string;
  readonly username: string;
  readonly ispId: string;
  readonly userId: string;
  readonly role: "GUEST";
  readonly email: string;
}

export interface ConsoleWorld {
  readonly state: CaptureSpec["world"];
  /** What answers the console's `/api` (and `/s3`) for this world. */
  readonly handle: ApiHandler;
  /** Who is signed in, when the state has somebody. */
  readonly signer: Signer | undefined;
  /** Addresses the frames of this world may show. */
  readonly syntheticEmails: readonly string[];
  /** An id token of `signer`, signed by this process's issuer, as Cognito would hand it to the console. */
  idToken(signer: Signer): string;
  /** The capture's route with the ids of this world in place of `{order:24817}` and `{case:24818}`. */
  route(template: string): Promise<string>;
}

const ROOT = join(import.meta.dirname, "../..");
const GUEST_TEMPLATE = join(ROOT, "scripts/seed/data/worlds/guest.json");
// The phone hashes of a capture world: a key of the capture only (the world is synthetic and never
// leaves this process), fixed so two runs build the same rows.
const PHONE_HASH_KEY = deriveSubkey("landing-capture-world-key-not-a-secret", "phone-hash");

/**
 * The guest's world, built by the product's own factory from the `guest` template (packages/bff/src/
 * worlds/factory.ts, neutral brand), and the account as `GuestWorlds` leaves it once the world is
 * ready: the registry row the token's `sub` resolves to and the account's current world, `READY`.
 */
async function seedGuestWorld(memory: MemoryConnector, signer: Signer): Promise<void> {
  const now = () => new Date(CAPTURE_NOW);
  const template = readFileSync(GUEST_TEMPLATE, "utf8");
  const built = await buildWorld(
    {
      connector: memory.connector,
      client: memory.client,
      template: () => Promise.resolve(template),
      brand: () => ({ mode: "neutral" }),
      phoneHash: (phone) => phoneHash(PHONE_HASH_KEY, phone),
      now,
    },
    { ispId: signer.ispId, origin: "SIGNUP", ownerUserId: signer.userId },
  );
  await memory.connector.isps.putUser({
    ispId: signer.ispId,
    userId: signer.userId,
    role: signer.role,
    name: "Invitado",
    cognitoSub: signer.sub,
    active: true,
    email: signer.email,
    guestOrigin: "SIGNUP",
    cognitoUsername: signer.username,
    lastLoginAt: CAPTURE_NOW.toISOString(),
  });
  const account = { userId: signer.userId, guestOrigin: "SIGNUP", ispId: signer.ispId, clockId: built.clockId, generation: 1, status: "READY", slotDay: "261013" } as const;
  await memory.client.put("Runtime", accountItem(account, now()));
}

function guestSigner(): Signer {
  // `gst-<ULID>` and `usr-g<ULID>`, as the signup names its users.
  const ulid = "01K6C4PTRE".padEnd(26, "0");
  return { sub: "5d0c2a7e-0000-4000-8000-00000000c0de", username: `gst-${ulid}`, ispId: GUEST_ISP, userId: `usr-g${ulid}`, role: "GUEST", email: VISITOR.email };
}

function signedBy(issuer: TestIssuer, signer: Signer): string {
  return issuer.idToken({
    sub: signer.sub,
    "cognito:username": signer.username,
    "cognito:groups": [signer.role],
    ispId: signer.ispId,
    userId: signer.userId,
    role: signer.role,
    isGuest: "true",
    email: signer.email,
  });
}

function idOf(issuer: TestIssuer): (signer: Signer) => string {
  return (signer) => signedBy(issuer, signer);
}

/** Routes of a world without ids of its own. */
async function plainRoute(template: string): Promise<string> {
  if (template.includes("{")) throw new Error(`${template}: only a scene world has ids to put in a route`);
  return template;
}

/** A fresh world in `state`: each capture starts from the seed as it is, whatever the previous one changed. */
export async function createConsoleWorld(spec: Pick<CaptureSpec, "world" | "scene">, origin: string): Promise<ConsoleWorld> {
  if (spec.world === "guest-scene") {
    if (spec.scene === undefined) throw new Error("a guest-scene capture names its scene");
    return createSceneWorld(spec.scene, origin);
  }
  const memory = createMemoryConnector({ now: () => new Date(CAPTURE_NOW) });
  // Tokens are signed with the machine's clock: the verifier checks their expiry against it.
  const issuer = createTestIssuer();
  const signer = spec.world === "guest-ready" ? guestSigner() : undefined;
  if (signer) await seedGuestWorld(memory, signer);
  const deps = testContextDeps(issuer, {
    connector: memory.connector,
    wallClock: () => new Date(CAPTURE_NOW),
    // Request logs would only repeat what the capture shows; refusals and errors still reach the terminal.
    loggerFor: (correlationId) => createLogger({ correlationId, level: "warn", bindings: { service: "bff-capture" } }),
    // The guest router reads this world's tables; a retry would only be recorded, never sent anywhere.
    guest: () => ({ client: memory.client, connector: memory.connector, provisioner: { request: async () => undefined }, now: () => new Date(CAPTURE_NOW) }),
  });
  // The console's ports over this world's memory (neutral brand, objects in memory), as the router tests bind them.
  const ports = memoryConsolePorts({ connector: memory.connector, client: memory.client, hashPhone: (phone) => phoneHash(PHONE_HASH_KEY, phone), realClock: { now: async () => new Date(CAPTURE_NOW) }, origin });
  return { state: spec.world, handle: apiHandler(bindConsolePorts(deps, ports)), signer, syntheticEmails: [VISITOR.email], idToken: idOf(issuer), route: plainRoute };
}

/** The rehearsal guest, as the pre-token trigger would stamp it (the UI server registers it on first sight). */
function sceneSigner(): Signer {
  const ulid = "01K6C4PTRS".padEnd(26, "0");
  return { sub: "5d0c2a7e-0000-4000-8000-00000000c0df", username: `guest-test-${ulid.slice(-4)}`, ispId: SCENE_ISP, userId: `usr-e2e-${"c0df".padStart(12, "0")}`, role: "GUEST", email: VISITOR.email };
}

/** Every address of the world's people and customers, as the console masks them, and the product's senders. */
function maskedMailboxes(rows: readonly Record<string, unknown>[]): string[] {
  const emails = rows.flatMap((row) => (typeof row.email === "string" ? [row.email] : []));
  return [...emails.map(maskEmail), `actas@${CAPTURE_EMAIL_DOMAIN}`, `avisos@${CAPTURE_EMAIL_DOMAIN}`];
}

/**
 * What a worker would have finished by the scene's instant: the timers the jump sent to the queue fired
 * and nothing left in flight. The capture runs no worker, and a frame never shows a world busy waiting.
 */
export async function settleWorld(connector: Connector, clockId: string): Promise<void> {
  const clock = await readWorldClock(connector, clockId);
  for (const timer of await scheduledTimers(clock, { data: connector }, clock.pausedSimNow)) {
    await connector.timers.setTimerStatus({ home: timer.home, kind: timer.kind, timerId: timer.timerId }, { status: "FIRED", firedBy: "CLOCK", firedAtSim: timer.dueAtSim }, timer.version);
  }
  const installers = await connector.people.listPeople(SCENE_ISP, "INSTALLER");
  for (const installer of installers) {
    for (const eventId of (await connector.worlds.getInstallerState(installer.personId))?.inFlight ?? []) await connector.worlds.clearInFlight(installer.personId, clockId, eventId);
  }
  for (const eventId of (await connector.worlds.getWorldState(clockId))?.inFlight ?? []) await connector.worlds.clearWorldInFlight(clockId, eventId);
}

/** The local UI server's console, the rehearsal world jumped to `scene.jump` and holding the story up to `scene.through`. */
async function createSceneWorld(scene: SceneSetup, origin: string): Promise<ConsoleWorld> {
  const issuer = createTestIssuer();
  const app = await createUiApp({ origin, pool: { userPoolId: TEST_POOL.userPoolId, clientIds: [TEST_POOL.clientId] }, jwks: issuer.jwks });
  const guest = createQaCaller({ role: "GUEST", clockId: GUEST_TEST_CLOCK_ID }, app.deps);
  await guest.clock.jumpToScene({ sceneId: scene.jump });
  await settleWorld(app.memory.connector, GUEST_TEST_CLOCK_ID);
  const world = { connector: app.memory.connector, objects: app.ports.objects, ispId: SCENE_ISP, clockId: GUEST_TEST_CLOCK_ID, now: () => new Date() };
  if (scene.through !== null) {
    const entries = sceneStory(scene.jump, scene.through);
    // The certificate's document is the one the deliveries stored, so the story's own entry is not written twice.
    await seedStoryEvidence(world, entries);
    await seedStoryMail(world, entries);
    await seedStoryThread(world, entries);
  }
  const ids = storyIds(SCENE_ISP);
  const people = app.memory.client.dump("People").filter((row) => row.clockId === GUEST_TEST_CLOCK_ID);
  return {
    state: "guest-scene",
    handle: app.handle,
    signer: sceneSigner(),
    syntheticEmails: [VISITOR.email, ...maskedMailboxes(people)],
    idToken: idOf(issuer),
    async route(template) {
      let route = template.replace(/\{order:(\d{5})\}/g, (_match, number: string) => ids.order(number));
      for (const [placeholder, number] of [...route.matchAll(/\{case:(\d{5})\}/g)].map((match) => [match[0], match[1] ?? ""] as const)) {
        const cases = await app.memory.connector.cases.listCasesOfWorkOrder(ids.order(number));
        const latest = cases.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (latest === undefined) throw new Error(`the scene ${scene.jump} has no case of order ${number}`);
        route = route.replace(placeholder, latest.caseId);
      }
      return route;
    },
  };
}
