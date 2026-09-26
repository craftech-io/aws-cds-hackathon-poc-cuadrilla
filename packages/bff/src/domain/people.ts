// `People` table (docs/architecture.md §5): staff (installers, supervisors, zone chiefs), customers,
// the WhatsApp opt-in with its history, the measured installer profile, the supervisor's shift
// window (plan B "TURNO") and the per-world uniqueness claim of a phone (`ADDR#<clockId>#<phoneHash>`).
// Phones and emails are stored in clear only here; every lookup goes by the HMAC of the address.
import { z } from "zod";
import {
  CaseReason,
  ClockId,
  CrewId,
  CustomerId,
  InstallerId,
  IsoInstant,
  IspId,
  PersonId,
  PersonRole,
  RejectReason,
  Symptom,
  ZoneId,
} from "@cuadrilla/shared";
import { E164, EmailAddress, HexHash, HistoryEntry, NonEmptyText, defineEntity } from "./common";

/** Roles of staff (`Person`); customers are their own entity. */
export const StaffRole = PersonRole.exclude(["CUSTOMER"]);
export type StaffRole = z.infer<typeof StaffRole>;

/**
 * A staff member of one world's operator. `active` is the allow list: only active people with a
 * registered phone may talk to Cuadrilla. `lastInboundAtSim` measures the 24 h window of synthetic
 * identities with the world clock; `lastInboundAtReal` (Meta's `timestamp`) that of real phones of
 * the live world (ADR-0002).
 */
export const Person = defineEntity("Person", {
  personId: PersonId,
  ispId: IspId,
  clockId: ClockId,
  role: StaffRole,
  firstName: NonEmptyText.max(80),
  lastName: NonEmptyText.max(80),
  crewId: CrewId.optional(),
  zoneId: ZoneId.optional(),
  phone: E164.optional(),
  phoneHash: HexHash.optional(),
  email: EmailAddress.optional(),
  active: z.boolean(),
  lastInboundAtSim: IsoInstant.optional(),
  lastInboundAtReal: IsoInstant.optional(),
  history: z.array(HistoryEntry).default([]),
});
export type Person = z.infer<typeof Person>;

/** The holder of the service at the address of an order. Never talks to the agent. */
export const Customer = defineEntity("Customer", {
  customerId: CustomerId,
  ispId: IspId,
  clockId: ClockId,
  firstName: NonEmptyText.max(80),
  lastName: NonEmptyText.max(80),
  addressLine: NonEmptyText.max(200),
  neighborhood: NonEmptyText.max(120),
  phone: E164.optional(),
  email: EmailAddress,
  /** Internal note of the operator (may carry synthetic identifiers; masked before any output). */
  note: z.string().max(1000).optional(),
});
export type Customer = z.infer<typeof Customer>;

/** How the opt-in was given: the "ALTA" keyword (from the join poster's QR), the console or QA. */
export const ConsentMedium = z.enum(["WHATSAPP_KEYWORD", "CONSOLE", "SEED", "QA"]);
export type ConsentMedium = z.infer<typeof ConsentMedium>;

export const ConsentStatus = z.enum(["GRANTED", "REVOKED"]);
export type ConsentStatus = z.infer<typeof ConsentStatus>;

/** `WHATSAPP_OPT_IN` of a person, with the version of the text shown and its dated history. */
export const Consent = defineEntity("Consent", {
  personId: PersonId,
  clockId: ClockId,
  kind: z.literal("WHATSAPP_OPT_IN"),
  status: ConsentStatus,
  medium: ConsentMedium,
  textVersion: z.string().min(1).max(32),
  grantedAtSim: IsoInstant.optional(),
  revokedAtSim: IsoInstant.optional(),
  history: z.array(HistoryEntry).default([]),
});
export type Consent = z.infer<typeof Consent>;

/** One measured event of an installer (rejected photo, failed troubleshooting step, case). */
export const ProfileEvent = z.object({
  kind: z.enum(["REJECT", "STEP", "CASE"]),
  code: z.union([RejectReason, Symptom, CaseReason]),
  atSim: IsoInstant,
  workOrderId: z.string().optional(),
});
export type ProfileEvent = z.infer<typeof ProfileEvent>;

/** Events kept per profile; enough for a rolling 30-day window of a demo installer. */
export const PROFILE_EVENT_LIMIT = 200;

/**
 * Measured profile of an installer (not AgentCore Memory): counts by reason plus the dated events
 * the 30-day window is computed from (`get_work_order` → `facts.tips`).
 */
export const InstallerProfile = defineEntity("InstallerProfile", {
  installerId: InstallerId,
  clockId: ClockId,
  rejects: z.partialRecord(RejectReason, z.int().min(0)).default({}),
  stepsBySymptom: z.partialRecord(Symptom, z.int().min(0)).default({}),
  casesByReason: z.partialRecord(CaseReason, z.int().min(0)).default({}),
  events: z.array(ProfileEvent).default([]),
});
export type InstallerProfile = z.infer<typeof InstallerProfile>;

/** Plan B: a supervisor who sent "TURNO" can receive interactive case messages until `closesAtSim`. */
export const ShiftWindow = defineEntity("ShiftWindow", {
  personId: PersonId,
  clockId: ClockId,
  openedAtSim: IsoInstant,
  closesAtSim: IsoInstant,
});
export type ShiftWindow = z.infer<typeof ShiftWindow>;

/** Uniqueness of a phone inside a world: the row exists while `personId` holds that phone. */
export const AddressClaim = defineEntity("AddressClaim", {
  clockId: ClockId,
  phoneHash: HexHash,
  personId: PersonId,
});
export type AddressClaim = z.infer<typeof AddressClaim>;

/** The phone matched two people of the same world: identity refuses to choose (never guess). */
export class AmbiguousIdentityError extends Error {
  override readonly name = "AmbiguousIdentityError";
  constructor(readonly personIds: readonly string[]) {
    super(`phone matches ${personIds.length} people of the same world`);
  }
}
