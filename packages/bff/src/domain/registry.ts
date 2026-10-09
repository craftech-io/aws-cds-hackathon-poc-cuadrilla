// Every entity schema by its `entity` discriminator, and the table each one lives in. The seed loader
// and `scripts/seed/__tests__/conforms-to-domain.test.ts` validate every item through here, and the
// connector refuses a row whose entity does not belong to the table it came from.
import type { z } from "zod";
import { Decision } from "./audit";
import { Case } from "./cases";
import { EntityName } from "./common";
import { Message, MessageEvent, OutboundEmail, TurnNote } from "./conversations";
import { ConsoleUser, Crew, Isp, IspSettings, ShiftRoster, Zone } from "./isps";
import { ConversationKpi, EvalResult } from "./metrics";
import { AddressClaim, Consent, Customer, InstallerProfile, Person, ShiftWindow } from "./people";
import { EvalPhoto, EvalQuestion, KbThreshold, ManualIndex, NameCheck, RateCard, RejectReasonCopy, Rubric, SafetyLexicon, Template } from "./reference";
import { CapCounter, Clock, Counter, Idempotency, KillSwitch, Nonce, Session, Turn, TurnResult } from "./runtime";
import { Faults, InstallerState, JoinCode, Lease, LiveWorld, PendingMail, PhoneLease, Probe, Tombstone, Upload, WorldSession, WorldState } from "./runtime-world";
import { Timer } from "./timers";
import { Certificate, ChecklistEntry, Evidence, PhotoValidation, TroubleshootingStep, WorkOrder } from "./work-orders";

/** The tables of docs/architecture.md §5 this domain models (the mocks own `Network` and `Dispatch`). */
export const DOMAIN_TABLES = ["Isps", "People", "WorkOrders", "Cases", "Conversations", "AuditLog", "Reference", "Runtime", "CuadrillaMetrics"] as const;
export type DomainTable = (typeof DOMAIN_TABLES)[number];

interface EntitySpec {
  readonly schema: z.ZodType;
  readonly tables: readonly DomainTable[];
}

const spec = (schema: z.ZodType, ...tables: DomainTable[]): EntitySpec => ({ schema, tables });

export const ENTITIES: Readonly<Record<EntityName, EntitySpec>> = {
  Isp: spec(Isp, "Isps"),
  IspSettings: spec(IspSettings, "Isps"),
  Zone: spec(Zone, "Isps"),
  Crew: spec(Crew, "Isps"),
  ShiftRoster: spec(ShiftRoster, "Isps"),
  ConsoleUser: spec(ConsoleUser, "Isps"),
  Person: spec(Person, "People"),
  Customer: spec(Customer, "People"),
  Consent: spec(Consent, "People"),
  InstallerProfile: spec(InstallerProfile, "People"),
  ShiftWindow: spec(ShiftWindow, "People"),
  AddressClaim: spec(AddressClaim, "People"),
  WorkOrder: spec(WorkOrder, "WorkOrders"),
  ChecklistItem: spec(ChecklistEntry, "WorkOrders"),
  Evidence: spec(Evidence, "WorkOrders"),
  PhotoValidation: spec(PhotoValidation, "WorkOrders"),
  TroubleshootingStep: spec(TroubleshootingStep, "WorkOrders"),
  Certificate: spec(Certificate, "WorkOrders"),
  Timer: spec(Timer, "WorkOrders", "Cases", "People"),
  Case: spec(Case, "Cases"),
  Message: spec(Message, "Conversations"),
  MessageEvent: spec(MessageEvent, "Conversations"),
  TurnNote: spec(TurnNote, "Conversations"),
  OutboundEmail: spec(OutboundEmail, "Conversations"),
  Decision: spec(Decision, "AuditLog"),
  Template: spec(Template, "Reference"),
  RateCard: spec(RateCard, "Reference"),
  NameCheck: spec(NameCheck, "Reference"),
  Rubric: spec(Rubric, "Reference"),
  SafetyLexicon: spec(SafetyLexicon, "Reference"),
  ManualIndex: spec(ManualIndex, "Reference"),
  KbThreshold: spec(KbThreshold, "Reference"),
  EvalQuestion: spec(EvalQuestion, "Reference"),
  EvalPhoto: spec(EvalPhoto, "Reference"),
  RejectReasonCopy: spec(RejectReasonCopy, "Reference"),
  Session: spec(Session, "Runtime"),
  Turn: spec(Turn, "Runtime"),
  TurnResult: spec(TurnResult, "Runtime"),
  Nonce: spec(Nonce, "Runtime"),
  Clock: spec(Clock, "Runtime"),
  Idempotency: spec(Idempotency, "Runtime"),
  Counter: spec(Counter, "Runtime"),
  CapCounter: spec(CapCounter, "Runtime"),
  KillSwitch: spec(KillSwitch, "Runtime"),
  InstallerState: spec(InstallerState, "Runtime"),
  WorldState: spec(WorldState, "Runtime"),
  PendingMail: spec(PendingMail, "Runtime"),
  Lease: spec(Lease, "Runtime"),
  PhoneLease: spec(PhoneLease, "Runtime"),
  JoinCode: spec(JoinCode, "Runtime"),
  Upload: spec(Upload, "Runtime"),
  LiveWorld: spec(LiveWorld, "Runtime"),
  Tombstone: spec(Tombstone, "Runtime"),
  Probe: spec(Probe, "Runtime"),
  Faults: spec(Faults, "Runtime"),
  WorldSession: spec(WorldSession, "Runtime"),
  ConversationKpi: spec(ConversationKpi, "CuadrillaMetrics"),
  EvalResult: spec(EvalResult, "CuadrillaMetrics"),
};

export function entitySchema(entity: EntityName): z.ZodType {
  return ENTITIES[entity].schema;
}

/** Whether `entity` may be stored in `table`. */
export function entityBelongsTo(entity: EntityName, table: DomainTable): boolean {
  return ENTITIES[entity].tables.includes(table);
}

/** Entities a table holds, in declaration order. */
export function entitiesOf(table: DomainTable): EntityName[] {
  return EntityName.options.filter((entity) => entityBelongsTo(entity, table));
}

export type EntityCheck = { readonly ok: true; readonly entity: EntityName; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** Validates a stored or seeded item of `table` by its own `entity` discriminator. */
export function checkEntity(table: DomainTable, item: unknown): EntityCheck {
  if (typeof item !== "object" || item === null) return { ok: false, error: "item is not an object" };
  const entity = EntityName.safeParse((item as { entity?: unknown }).entity);
  if (!entity.success) return { ok: false, error: "unknown entity" };
  if (!entityBelongsTo(entity.data, table)) return { ok: false, error: `${entity.data} does not belong to ${table}` };
  const parsed = entitySchema(entity.data).safeParse(item);
  if (!parsed.success) return { ok: false, error: `${entity.data}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}` };
  return { ok: true, entity: entity.data, value: parsed.data };
}
