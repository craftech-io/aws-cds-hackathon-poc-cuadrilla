// The world the capture pipeline shows (capture-console.ts), and the base of the local UI server of the
// console's specs (tests/ui-server/): the real BFF over an in-memory connector seeded only from
// scripts/seed/data, the real clock of the world fixed at the story's day, and a throwaway token
// issuer whose keys exist only in this process. The BFF verifies every request with its real verifier
// against this issuer; nothing here accepts an unsigned token and nothing here ships in a Lambda.
//
//   visitor       nobody is signed in: the landing, the signup form and its code step
//   guest-ready   a guest of the own signup, signed in, with a world of the `guest` template that is
//                 ready (clock paused at 07:00 of the story's day, nothing pending)
//
// The scenes of the console (the presets of "Saltar a escena") join as more states once their
// presets exist. Every state runs the neutral brand: this process has no BrandConfig, so the
// partner's name or logo can never reach a versioned picture (ADR-0018). The local overrides with
// real phones and addresses are never read, and the only address a frame may show is the synthetic
// visitor's, on a domain reserved for examples.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_POOL, type TestIssuer, createTestIssuer, testContextDeps } from "../../packages/bff/src/auth/testing";
import { type MemoryConnector, createMemoryConnector } from "../../packages/bff/src/connector/index";
import { accountItem } from "../../packages/bff/src/guest/account";
import { deriveSubkey, phoneHash } from "../../packages/bff/src/lib/crypto";
import { createLogger } from "../../packages/bff/src/lib/log";
import type { ContextDeps } from "../../packages/bff/src/routers/deps";
import { buildWorld } from "../../packages/bff/src/worlds/factory";
import type { WorldState } from "./captures";

export { TEST_POOL };

/** The story's day at 07:00 in Mexico City: the real clock of every capture world. */
export const CAPTURE_NOW = new Date("2026-10-13T13:00:00.000Z");

/** The visitor who signs up in the captures: a synthetic address on a domain reserved for examples. */
export const VISITOR = { email: "prueba@example.com" } as const;

/** The operator of the capture guest's world: a signup generation of the story's day (`isp-guest-s<yymmdd><5 base32>`). */
export const GUEST_ISP = "isp-guest-s261013landg";

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
  readonly state: WorldState;
  readonly memory: MemoryConnector;
  readonly deps: ContextDeps;
  /** Who is signed in, when the state has somebody. */
  readonly signer: Signer | undefined;
  /** Addresses the frames of this world may show. */
  readonly syntheticEmails: readonly string[];
  /** An id token of `signer`, signed by this process's issuer, as Cognito would hand it to the console. */
  idToken(signer: Signer): string;
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

/** A fresh world in `state`: each capture starts from the seed as it is, whatever the previous one changed. */
export async function createConsoleWorld(state: WorldState): Promise<ConsoleWorld> {
  const memory = createMemoryConnector({ now: () => new Date(CAPTURE_NOW) });
  // Tokens are signed with the machine's clock: the verifier checks their expiry against it.
  const issuer = createTestIssuer();
  const signer = state === "guest-ready" ? guestSigner() : undefined;
  if (signer) await seedGuestWorld(memory, signer);
  const deps = testContextDeps(issuer, {
    connector: memory.connector,
    wallClock: () => new Date(CAPTURE_NOW),
    // Request logs would only repeat what the capture shows; refusals and errors still reach the terminal.
    loggerFor: (correlationId) => createLogger({ correlationId, level: "warn", bindings: { service: "bff-capture" } }),
    // The guest router reads this world's tables; a retry would only be recorded, never sent anywhere.
    guest: () => ({ client: memory.client, connector: memory.connector, provisioner: { request: async () => undefined }, now: () => new Date(CAPTURE_NOW) }),
  });
  return { state, memory, deps, signer, syntheticEmails: [VISITOR.email], idToken: (who) => signedBy(issuer, who) };
}
