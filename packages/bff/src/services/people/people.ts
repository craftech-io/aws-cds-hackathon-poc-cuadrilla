// `upsert_person` and `deactivate_person` (docs/tool-catalog.md; FL-001, FL-008): the console's (and the
// QaDriver's) registry of a world's staff. Installers and supervisors are the allow list of the channel;
// zone chiefs receive the ladder's last alert by email.
//
//   upsert   creates a person (active, without opt-in: the opt-in is the person's own "ALTA") or edits
//            one of the caller's world. The phone is unique per world (`ADDR#<clockId>#<phoneHash>`,
//            written in the same transaction as the person): a phone taken in the same world is
//            `CONFLICT`; the same phone in another world is no conflict and is never mentioned. Phones
//            and emails follow address-rules.ts (`DENY PHONE_NOT_SYNTHETIC`, `RECIPIENT_NOT_ALLOWED`).
//            The role never changes; a field left out keeps its value and `null` clears it.
//   active   switches the allow list with a dated history (`PolicyAudit` replays it). A deactivated
//            installer's open orders of the world's day come back so the console marks them for
//            reassignment; their messages are then those of an unknown number (FL-004).
//
// Audit: `ACTION PERSON_CREATED | PERSON_UPDATED | PERSON_DEACTIVATED | PERSON_ACTIVATED`, `DENY
// PERSON_UPSERT` with reason `PHONE_NOT_SYNTHETIC`, `RECIPIENT_NOT_ALLOWED` or `CONFLICT`. Never a phone
// or an email in a row, a log line or an error message.
import { z } from "zod";
import {
  ConnectorError,
  CrewId,
  type IdKind,
  PersonId,
  ToolError,
  type WorkOrderStatus,
  ZoneId,
  makeId,
  maskEmail,
  maskPhone,
} from "@cuadrilla/shared";
import type { PersonPatch, PhoneContact } from "../../connector/ports";
import { NonEmptyText } from "../../domain/common";
import { type Person, StaffRole } from "../../domain/people";
import { ulid } from "../../lib/crypto";
import { localDateOf } from "../business-hours/zoned-time";
import { ADDRESS_REASON, type AddressOptions, EMAIL_FENCE_RULES, checkStaffEmail, checkStaffPhone } from "./address-rules";
import { ACTING_ROLES, type DirectCall, type ServiceDeps, deny, inWorld, openCall, parseInput, recordDecision, worldNow } from "./direct-call";

export interface PeopleDeps extends ServiceDeps {
  /** HMAC of a normalized phone with the `phone-hash` subkey (lib/crypto.ts `phoneHash`). */
  readonly hashPhone: (phone: string) => string;
  readonly addresses?: AddressOptions;
  /** Body of a new person id (a ULID by default, stamped with real time). */
  readonly newIdBody?: () => string;
}

const Contact = z.string().trim().min(1).max(254);

export const UpsertPersonInput = z
  .object({
    /** Absent: a new person. */
    personId: PersonId.optional(),
    /** Required to create; an edit may repeat it but never change it. */
    role: StaffRole.optional(),
    firstName: NonEmptyText.max(80),
    lastName: NonEmptyText.max(80),
    crewId: CrewId.nullable().optional(),
    zoneId: ZoneId.nullable().optional(),
    phone: Contact.nullable().optional(),
    email: Contact.nullable().optional(),
  })
  .strict();
export type UpsertPersonInput = z.input<typeof UpsertPersonInput>;

export const SetPersonActiveInput = z
  .object({ personId: PersonId, active: z.boolean(), reason: z.string().trim().min(1).max(200).optional() })
  .strict();
export type SetPersonActiveInput = z.input<typeof SetPersonActiveInput>;

/** What the console shows of a person: contacts masked, never in clear. */
export interface PersonView {
  readonly personId: string;
  readonly role: StaffRole;
  readonly firstName: string;
  readonly lastName: string;
  readonly crewId?: string;
  readonly zoneId?: string;
  readonly phoneMasked?: string;
  readonly emailMasked?: string;
  readonly active: boolean;
}

export function personView(person: Person): PersonView {
  return {
    personId: person.personId,
    role: person.role,
    firstName: person.firstName,
    lastName: person.lastName,
    active: person.active,
    ...(person.crewId === undefined ? {} : { crewId: person.crewId }),
    ...(person.zoneId === undefined ? {} : { zoneId: person.zoneId }),
    ...(person.phone === undefined ? {} : { phoneMasked: maskPhone(person.phone) }),
    ...(person.email === undefined ? {} : { emailMasked: maskEmail(person.email) }),
  };
}

const ID_KIND: Readonly<Record<StaffRole, IdKind>> = { INSTALLER: "installer", SUPERVISOR: "supervisor", ZONE_CHIEF: "zoneChief" };

export const PEOPLE_REASON = {
  ROLE_REQUIRED: "ROLE_REQUIRED",
  ROLE_IMMUTABLE: "ROLE_IMMUTABLE",
  CREW_REQUIRED: "CREW_REQUIRED",
  CREW_UNKNOWN: "CREW_UNKNOWN",
  ZONE_REQUIRED: "ZONE_REQUIRED",
  ZONE_UNKNOWN: "ZONE_UNKNOWN",
  ZONE_MISMATCH: "ZONE_MISMATCH",
  NO_CREW_FOR_ROLE: "NO_CREW_FOR_ROLE",
  PHONE_REQUIRED: "PHONE_REQUIRED",
  EMAIL_REQUIRED: "EMAIL_REQUIRED",
  PHONE_TAKEN: "CONFLICT",
} as const;

const invalid = (message: string, reason: string) => new ToolError("INVALID", message, reason);

/** `undefined` keeps the stored value, `null` clears it. */
function merged<T>(given: T | null | undefined, stored: T | undefined): T | undefined {
  return given === undefined ? stored : (given ?? undefined);
}

interface Placement {
  readonly crewId?: string;
  readonly zoneId?: string;
}

/** Crew and zone by role: field staff belong to a crew (and its zone), a zone chief to a zone only. */
async function placementOf(deps: PeopleDeps, call: DirectCall, role: StaffRole, crewId: string | undefined, zoneId: string | undefined): Promise<Placement> {
  if (role === "ZONE_CHIEF") {
    if (crewId !== undefined) throw invalid("a zone chief belongs to no crew", PEOPLE_REASON.NO_CREW_FOR_ROLE);
    if (zoneId === undefined) throw invalid("a zone chief needs a zone", PEOPLE_REASON.ZONE_REQUIRED);
    if ((await deps.connector.isps.getZone(call.ispId, zoneId)) === undefined) throw invalid("unknown zone", PEOPLE_REASON.ZONE_UNKNOWN);
    return { zoneId };
  }
  if (crewId === undefined) throw invalid("installers and supervisors belong to a crew", PEOPLE_REASON.CREW_REQUIRED);
  const crew = await deps.connector.isps.getCrew(call.ispId, crewId);
  if (crew === undefined) throw invalid("unknown crew", PEOPLE_REASON.CREW_UNKNOWN);
  if (zoneId !== undefined && zoneId !== crew.zoneId) throw invalid("the zone is not the crew's", PEOPLE_REASON.ZONE_MISMATCH);
  return { crewId, zoneId: crew.zoneId };
}

interface Contacts {
  readonly contact?: PhoneContact;
  readonly email?: string;
}

/**
 * Checks the contacts the input brings against the world's rules (a stored, unchanged contact is not
 * re-checked: a phone the operator registered for the live world stays). A refusal by policy is
 * audited before it is thrown; a malformed phone is a plain `INVALID`.
 */
async function checkContacts(deps: PeopleDeps, call: DirectCall, atSim: string, given: { phone?: string; email?: string }, refs: Record<string, string>): Promise<Contacts> {
  const denial = (reason: string, message: string, ruleIds: readonly string[]) => deny(deps, call, { code: "RECIPIENT_NOT_ALLOWED", message, reason, action: "PERSON_UPSERT", atSim, ruleIds, refs });
  let contact: PhoneContact | undefined;
  if (given.phone !== undefined) {
    try {
      const phone = checkStaffPhone(given.phone, call.clockId, deps.addresses);
      contact = { phone, phoneHash: deps.hashPhone(phone) };
    } catch (error) {
      if (error instanceof ToolError && error.reason === ADDRESS_REASON.PHONE_NOT_SYNTHETIC) return denial(ADDRESS_REASON.PHONE_NOT_SYNTHETIC, error.message, []);
      throw error;
    }
  }
  let email: string | undefined;
  if (given.email !== undefined) {
    try {
      email = checkStaffEmail(given.email, call.clockId, deps.addresses).address;
    } catch (error) {
      if (error instanceof ToolError && error.code === "RECIPIENT_NOT_ALLOWED") return denial("RECIPIENT_NOT_ALLOWED", error.message, EMAIL_FENCE_RULES);
      throw error;
    }
  }
  return { ...(contact === undefined ? {} : { contact }), ...(email === undefined ? {} : { email }) };
}

function storedContact(person: Person | undefined): PhoneContact | undefined {
  return person?.phone === undefined || person.phoneHash === undefined ? undefined : { phone: person.phone, phoneHash: person.phoneHash };
}

/** A phone already held by another person of the same world (claims of other worlds never collide). */
async function phoneTaken(deps: PeopleDeps, call: DirectCall, phoneHash: string, personId: string | undefined): Promise<boolean> {
  const claim = await deps.connector.people.getAddressClaim(call.clockId, phoneHash);
  return claim !== undefined && claim.personId !== personId;
}

export interface UpsertPersonResult {
  readonly created: boolean;
  readonly person: PersonView;
}

export async function upsertPerson(deps: PeopleDeps, caller: unknown, raw: unknown): Promise<UpsertPersonResult> {
  const call = openCall(caller, { callers: ["CONSOLE", "QA"], consoleRoles: ACTING_ROLES });
  const input = parseInput(UpsertPersonInput, raw);
  const { atSim } = await worldNow(deps, call);
  const existing = input.personId === undefined ? undefined : inWorld(call, await deps.connector.people.getPerson(input.personId), "person");
  const role = existing?.role ?? input.role;
  if (role === undefined) throw invalid("a new person needs a role", PEOPLE_REASON.ROLE_REQUIRED);
  if (existing !== undefined && input.role !== undefined && input.role !== existing.role) throw invalid("the role of a person never changes", PEOPLE_REASON.ROLE_IMMUTABLE);

  const placement = await placementOf(deps, call, role, merged(input.crewId, existing?.crewId), merged(input.zoneId, existing?.zoneId));
  const refs: Record<string, string> = existing === undefined ? {} : { personId: existing.personId };
  const phoneGiven = typeof input.phone === "string" && input.phone !== existing?.phone;
  const emailGiven = typeof input.email === "string" && input.email !== existing?.email;
  const checked = await checkContacts(deps, call, atSim, { ...(phoneGiven ? { phone: input.phone as string } : {}), ...(emailGiven ? { email: input.email as string } : {}) }, refs);
  const contact = phoneGiven ? checked.contact : input.phone === null ? undefined : storedContact(existing);
  const email = emailGiven ? checked.email : merged(input.email, existing?.email);
  if (role !== "ZONE_CHIEF" && contact === undefined) throw invalid("installers and supervisors need a phone", PEOPLE_REASON.PHONE_REQUIRED);
  if (role === "ZONE_CHIEF" && email === undefined) throw invalid("a zone chief needs an email", PEOPLE_REASON.EMAIL_REQUIRED);
  const conflict = () => deny(deps, call, { code: "CONFLICT", message: "the phone is already registered to another person of this world", reason: PEOPLE_REASON.PHONE_TAKEN, action: "PERSON_UPSERT", atSim, refs });
  if (phoneGiven && contact !== undefined && (await phoneTaken(deps, call, contact.phoneHash, existing?.personId))) return conflict();

  try {
    if (existing === undefined) {
      const personId = makeId(ID_KIND[role], deps.newIdBody?.() ?? ulid((await deps.realClock.now()).getTime()));
      const person = await deps.connector.people.createPerson({
        personId,
        ispId: call.ispId,
        clockId: call.clockId,
        role,
        firstName: input.firstName,
        lastName: input.lastName,
        ...placement,
        ...(contact === undefined ? {} : contact),
        ...(email === undefined ? {} : { email }),
        active: true,
      });
      await recordDecision(deps, call, { decision: "ACTION", action: "PERSON_CREATED", atSim, refs: { personId }, detail: { role } });
      return { created: true, person: personView(person) };
    }
    const patch: PersonPatch = {
      firstName: input.firstName,
      lastName: input.lastName,
      crewId: placement.crewId ?? null,
      zoneId: placement.zoneId ?? null,
      email: email ?? null,
      ...(phoneGiven || input.phone === null ? { contact: contact ?? null } : {}),
    };
    const person = await deps.connector.people.updatePerson(existing.personId, patch, { expectedVersion: existing.version });
    const fields = changedFields(existing, person);
    await recordDecision(deps, call, { decision: "ACTION", action: "PERSON_UPDATED", atSim, refs, detail: { fields } });
    return { created: false, person: personView(person) };
  } catch (error) {
    // Lost the race for the phone's claim (or for the row): the same answer as the check above.
    if (error instanceof ConnectorError && error.code === "CONFLICT" && phoneGiven) return conflict();
    throw error;
  }
}

/** Names of the fields an edit changed (the audit's dated trail; values never, they may be contacts). */
function changedFields(before: Person, after: Person): string[] {
  const fields = ["firstName", "lastName", "crewId", "zoneId", "phoneHash", "email"] as const;
  return fields.filter((field) => before[field] !== after[field]).map((field) => (field === "phoneHash" ? "phone" : field));
}

/** Statuses of an order still to be done: the ones a deactivated installer leaves for reassignment. */
const OPEN_STATUSES: ReadonlySet<WorkOrderStatus> = new Set<WorkOrderStatus>(["SCHEDULED", "IN_PROGRESS", "RESCHEDULED"]);

export interface SetPersonActiveResult {
  readonly changed: boolean;
  readonly person: PersonView;
  /** Open orders of the world's day of a deactivated installer, for the console to reassign. */
  readonly needsReassignment: readonly string[];
}

/** `deactivate_person` (and its inverse): the allow list switch with its dated history. */
export async function setPersonActive(deps: ServiceDeps, caller: unknown, raw: unknown): Promise<SetPersonActiveResult> {
  const call = openCall(caller, { callers: ["CONSOLE", "QA"], consoleRoles: ACTING_ROLES });
  const input = parseInput(SetPersonActiveInput, raw);
  const now = await worldNow(deps, call);
  const current = inWorld(call, await deps.connector.people.getPerson(input.personId), "person");
  const orders =
    !input.active && current.role === "INSTALLER"
      ? (await deps.connector.workOrders.listInstallerDay(current.personId, localDateOf(new Date(now.atSim), now.timeZone))).filter((order) => order.clockId === call.clockId && OPEN_STATUSES.has(order.status))
      : [];
  const needsReassignment = orders.map((order) => order.workOrderId);
  if (current.active === input.active) return { changed: false, person: personView(current), needsReassignment };
  const person = await deps.connector.people.setActive(current.personId, input.active, { actor: call.actor, atSim: now.atSim, ...(input.reason === undefined ? {} : { reason: input.reason }) });
  await recordDecision(deps, call, {
    decision: "ACTION",
    action: input.active ? "PERSON_ACTIVATED" : "PERSON_DEACTIVATED",
    atSim: now.atSim,
    refs: { personId: person.personId },
    ...(input.active ? {} : { detail: { openWorkOrders: needsReassignment.length } }),
  });
  return { changed: true, person: personView(person), needsReassignment };
}
