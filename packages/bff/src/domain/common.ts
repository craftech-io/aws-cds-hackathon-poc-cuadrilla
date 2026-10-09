// Building blocks every entity schema shares (docs/architecture.md §5): the metadata each DynamoDB
// item carries, the history of transitions that `PolicyAudit` re-evaluates, actors, and the small
// value schemas that repeat across aggregates. The connector validates every row it writes and
// every row it reads back with these schemas (zod at the connector edge).
import { z } from "zod";
import { IsoInstant } from "@cuadrilla/shared";

/** Every persisted entity, by table (docs/architecture.md §5). The `entity` attribute of each item. */
export const EntityName = z.enum([
  // Isps
  "Isp",
  "IspSettings",
  "Zone",
  "Crew",
  "ShiftRoster",
  "ConsoleUser",
  // People
  "Person",
  "Customer",
  "Consent",
  "InstallerProfile",
  "ShiftWindow",
  "AddressClaim",
  // WorkOrders (and Timer, which also lives in Cases and People)
  "WorkOrder",
  "ChecklistItem",
  "Evidence",
  "PhotoValidation",
  "TroubleshootingStep",
  "Certificate",
  "Timer",
  // Cases
  "Case",
  // Conversations
  "Message",
  "MessageEvent",
  "TurnNote",
  "OutboundEmail",
  // AuditLog
  "Decision",
  // Reference
  "Template",
  "RateCard",
  "NameCheck",
  "Rubric",
  "SafetyLexicon",
  "ManualIndex",
  "KbThreshold",
  "EvalQuestion",
  "EvalPhoto",
  "RejectReasonCopy",
  // Runtime
  "Session",
  "Turn",
  "TurnResult",
  "Nonce",
  "Clock",
  "Idempotency",
  "Counter",
  "CapCounter",
  "KillSwitch",
  "InstallerState",
  "WorldState",
  "PendingMail",
  "Lease",
  "PhoneLease",
  "JoinCode",
  "Upload",
  "LiveWorld",
  "Tombstone",
  "Probe",
  "Faults",
  "WorldSession",
  // CuadrillaMetrics
  "ConversationKpi",
  "EvalResult",
]);
export type EntityName = z.infer<typeof EntityName>;

/** Which cloned world an item belongs to (docs/seed-spec.md §13); absent in the demo world. */
export const WorldTag = z.enum(["qa", "eval", "guest"]);
export type WorldTag = z.infer<typeof WorldTag>;

/** DynamoDB TTL value: epoch SECONDS (a Number; infra/storage-keys.ts). */
export const EpochSeconds = z.int().min(0);
export type EpochSeconds = z.infer<typeof EpochSeconds>;

/**
 * Metadata on every item: `version` drives optimistic locking; `synthetic` marks rows of the seed,
 * `seeded` rows a world preset wrote; `clockId`, `world`, `runId` and `expiresAt` scope an item to a
 * world and let DynamoDB expire the items of QA and evaluation worlds.
 */
export const EntityMeta = z.object({
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
  version: z.int().min(1),
  synthetic: z.boolean().default(false),
  seeded: z.boolean().optional(),
  world: WorldTag.optional(),
  runId: z.string().min(1).max(128).optional(),
  expiresAt: EpochSeconds.optional(),
});
export type EntityMeta = z.output<typeof EntityMeta>;

/** Schema of one entity: its discriminator, its own fields and the metadata. */
export function defineEntity<N extends EntityName, S extends z.ZodRawShape>(entity: N, shape: S) {
  return EntityMeta.extend({ entity: z.literal(entity) }).extend(shape);
}

/** Metadata only the connector stamps. */
export type StampedField = "entity" | "createdAt" | "updatedAt" | "version";

/**
 * Fields a caller supplies to create an entity (`NewEntity<typeof WorkOrder>`): the schema's input
 * (defaulted fields optional) without what the connector stamps; the scope flags (`synthetic`,
 * `seeded`, `world`, `runId`, `expiresAt`) stay optional for a seed or a world preset to set.
 */
export type NewEntity<S extends z.ZodType> = Omit<z.input<S>, StampedField>;

// ---- Actors and history ------------------------------------------------------------------------

/**
 * Who did something: `AGENT` (a tool invoked by the Harness), `SYSTEM` (deterministic code),
 * `SEED`, `QA`, `SCHEDULER`, `WORKER`, `CHANNEL`, `OPERATOR` (scripts run by Craftech's operator),
 * `PERSON:<personId>` (staff over WhatsApp) or `USER:<userId>` (console).
 */
export const Actor = z
  .string()
  .regex(/^(?:AGENT|SYSTEM|SEED|QA|SCHEDULER|WORKER|CHANNEL|OPERATOR|(?:PERSON|USER):[A-Za-z0-9_-]{1,128})$/, "expected an actor such as AGENT, SYSTEM, PERSON:<id> or USER:<id>");
export type Actor = z.infer<typeof Actor>;

export function personActor(personId: string): Actor {
  return Actor.parse(`PERSON:${personId}`);
}

export function userActor(userId: string): Actor {
  return Actor.parse(`USER:${userId}`);
}

/**
 * One dated transition. `field` names what changed (`status`, `active`, `consent`…), `to` its new
 * value; `atSim` is the world's simulated instant, `atReal` the machine's. PolicyAudit replays
 * these to learn what a rule saw at a past instant.
 */
export const HistoryEntry = z.object({
  field: z.string().min(1).max(64),
  from: z.string().max(256).optional(),
  to: z.string().max(256),
  atSim: IsoInstant.optional(),
  atReal: IsoInstant,
  actor: Actor,
  reason: z.string().max(500).optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/** Transitions kept per item; older entries fall off (the audit log keeps the full trail). */
export const HISTORY_LIMIT = 50;

/** Who, when and why for a transition the connector records in `history[]`. */
export interface Transition {
  readonly actor: Actor;
  readonly atSim?: string;
  readonly reason?: string;
}

// ---- Values that repeat ------------------------------------------------------------------------

export const NonEmptyText = z.string().trim().min(1);
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a lower-case SHA-256 hex digest");
export const S3Key = z.string().min(1).max(1024).regex(/^\S+$/, "expected an S3 object key");
export const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm");
/** Normalized E.164 (`normalizePhone` of @cuadrilla/shared). Only `People` stores it in clear. */
export const E164 = z.string().regex(/^\+\d{8,15}$/, "expected an E.164 phone number");
export const EmailAddress = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "expected an email address");
export const HexHash = z.string().regex(/^[0-9a-f]{64}$/, "expected an HMAC-SHA256 hex hash");

/** Opaque JSON the domain stores as is (tool outputs, preset payloads, rubric content). */
export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

/** DynamoDB string sets come back as `Set`; the domain sees a sorted array. */
export const StringSet = z
  .union([z.set(z.string()), z.array(z.string())])
  .transform((values) => [...values].sort())
  .default([]);

export const TokenUsage = z.object({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) });
export type TokenUsage = z.infer<typeof TokenUsage>;

