// Step 4 of docs/architecture-integrations.md §4.4: the world and the person of a screened message,
// never from anything the sender or a model wrote. A phone is unique inside a world
// (`ADDR#<clockId>#<phoneHash>`), so identity is always (world, phoneHash):
//
//   simulated  the world of the signed envelope; the person registered with that phone in it
//   live       a valid `PHONELEASE#<phoneHash>` (a real phone bound to a judge's world by code) →
//              its world and person; otherwise the person with that phone in the single live world
//              (`Runtime/LIVEWORLD`); otherwise an unknown number of the live world
//
// Two people with the same phone in a world is refused, never guessed: the sender is unknown.
import { type Person, AmbiguousIdentityError } from "../../domain/people";
import type { PhoneLease } from "../../domain/runtime-world";
import type { PeoplePort, WorldRuntimePort } from "../../connector/ports";
import { type SecretKey, phoneHash } from "../../lib/crypto";
import { type WhatsAppTransport, ispIdOfClock, normalizePhone } from "@cuadrilla/shared";

export interface SenderIdentity {
  /** `live` for a real phone (EUM Social), `simulated` for an identity of the simulator. */
  readonly transport: WhatsAppTransport;
  /** World of the message; `undefined` for a live phone with no lease while no world is live. */
  readonly clockId: string | undefined;
  readonly ispId: string | undefined;
  /** E.164 of the sender. Only ever used to answer; never logged or stored outside `People`. */
  readonly phone: string;
  readonly phoneHash: string;
  /** The person registered with this phone in the world, active or not. */
  readonly person: Person | undefined;
  /** The code-bound lease the live phone entered through. */
  readonly lease: PhoneLease | undefined;
  /** The phone matched two people of the world: treated as unknown. */
  readonly ambiguous: boolean;
}

export interface IdentityDeps {
  readonly people: Pick<PeoplePort, "findByPhone" | "getPerson">;
  readonly worlds: Pick<WorldRuntimePort, "getPhoneLease" | "getLiveWorld">;
  readonly phoneHashKey: SecretKey;
}

export interface SenderInput {
  readonly origin: "LIVE" | "SIMULATED";
  /** World of a simulated envelope. */
  readonly clockId?: string;
  /** `from` of the message: digits of the sender's number. */
  readonly waId: string;
}

async function personInWorld(deps: IdentityDeps, clockId: string, hash: string): Promise<{ person: Person | undefined; ambiguous: boolean }> {
  try {
    return { person: await deps.people.findByPhone(clockId, hash), ambiguous: false };
  } catch (error) {
    if (error instanceof AmbiguousIdentityError) return { person: undefined, ambiguous: true };
    throw error;
  }
}

export async function resolveSender(input: SenderInput, deps: IdentityDeps): Promise<SenderIdentity> {
  const phone = normalizePhone(`+${input.waId}`);
  const hash = phoneHash(deps.phoneHashKey, phone);
  const identity = (transport: WhatsAppTransport, clockId: string | undefined, found: { person: Person | undefined; ambiguous: boolean }, lease?: PhoneLease): SenderIdentity => ({
    transport,
    clockId,
    ispId: clockId === undefined ? undefined : ispIdOfClock(clockId),
    phone,
    phoneHash: hash,
    person: found.person,
    lease,
    ambiguous: found.ambiguous,
  });

  if (input.origin === "SIMULATED") {
    if (input.clockId === undefined) throw new RangeError("a simulated message carries its world");
    return identity("simulated", input.clockId, await personInWorld(deps, input.clockId, hash));
  }
  const lease = await deps.worlds.getPhoneLease(hash);
  if (lease !== undefined) {
    const person = await deps.people.getPerson(lease.personId);
    return identity("live", lease.clockId, { person: person?.clockId === lease.clockId ? person : undefined, ambiguous: false }, lease);
  }
  const liveWorld = await deps.worlds.getLiveWorld();
  if (liveWorld === undefined) return identity("live", undefined, { person: undefined, ambiguous: false });
  return identity("live", liveWorld.clockId, await personInWorld(deps, liveWorld.clockId, hash));
}

/** Staff of the allow list: an active installer or supervisor of the sender's world (`CP-ALLOWLIST`). */
export function allowlistedPerson(sender: SenderIdentity): Person | undefined {
  const person = sender.person;
  if (person === undefined || !person.active || person.clockId !== sender.clockId) return undefined;
  return person.role === "INSTALLER" || person.role === "SUPERVISOR" ? person : undefined;
}
