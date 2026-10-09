// `Runtime` table, world state (docs/architecture.md §5, §7, docs/architecture-integrations.md §4.4.1):
// what keeps an installer or a world busy (quiescence), the emails waiting for their first SES event,
// number leases of QA worlds, real phones bound to a guest world by code, simulator uploads, the
// single live world, tombstones of reset epochs, probes and the fault switches of QA worlds.
import { z } from "zod";
import { ClockId, ConsoleUserId, IsoInstant, PersonId, WorkOrderId } from "@cuadrilla/shared";
import { Actor, HexHash, JsonObject, S3Key, StringSet, defineEntity } from "./common";

/** A failed event on its last attempt: kept so a DLQ event never leaves the world busy (§7). */
export const ProcessError = z.object({ eventId: z.string().min(1).max(256), message: z.string().max(500), atReal: IsoInstant });
export type ProcessError = z.infer<typeof ProcessError>;

/** `INSTSTATE#<installerId>`: events in flight for the installer and the active work order. */
export const InstallerState = defineEntity("InstallerState", {
  installerId: z.string().min(1).max(128),
  clockId: ClockId.optional(),
  inFlight: StringSet,
  activeWorkOrderId: WorkOrderId.optional(),
  activeSetAtSim: IsoInstant.optional(),
  processError: ProcessError.optional(),
});
export type InstallerState = z.infer<typeof InstallerState>;

/** `WORLDSTATE#<clockId>`: events in flight in the world and the phone leases bound to it. */
export const WorldState = defineEntity("WorldState", {
  clockId: ClockId,
  inFlight: StringSet,
  phoneLeases: StringSet,
});
export type WorldState = z.infer<typeof WorldState>;

/** `PENDING#<clockId>` · `MAIL#<mailId>`: an email sent and still without its first SES event. */
export const PendingMail = defineEntity("PendingMail", {
  clockId: ClockId,
  mailId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  sentAtReal: IsoInstant,
  status: z.enum(["OPEN", "CLOSED"]),
  closedAtReal: IsoInstant.optional(),
  eventType: z.string().max(32).optional(),
});
export type PendingMail = z.infer<typeof PendingMail>;

/** Numbers QA worlds lease atomically: phones of the `+52 55 09xx xxxx` block and order numbers. */
export const LeaseKind = z.enum(["PHONE", "WONUM"]);
export type LeaseKind = z.infer<typeof LeaseKind>;

export const Lease = defineEntity("Lease", {
  leaseKind: LeaseKind,
  n: z.int().min(0),
  holder: z.string().min(1).max(200),
  acquiredAtReal: IsoInstant,
});
export type Lease = z.infer<typeof Lease>;

/** A real phone bound to a person of a guest world by a join code (48 h; unique per phone). */
export const PhoneLease = defineEntity("PhoneLease", {
  phoneHash: HexHash,
  clockId: ClockId,
  personId: PersonId,
  joinCode: z.string().min(1).max(32).optional(),
  boundAtReal: IsoInstant,
  /** Meta's `timestamp` of the last live event: the clock of `CP-WA-24H` for this phone. */
  lastInboundAtReal: IsoInstant.optional(),
});
export type PhoneLease = z.infer<typeof PhoneLease>;

/** One-use join code ("ALTA G07-4F2K"), 30 minutes, bound to a person of the guest's world. */
export const JoinCode = defineEntity("JoinCode", {
  code: z.string().regex(/^[A-Z0-9]{2,5}-[A-Z0-9]{4}$/, "expected a join code such as G07-4F2K"),
  clockId: ClockId,
  personId: PersonId,
  userId: ConsoleUserId,
  usedAtReal: IsoInstant.optional(),
  usedByPhoneHash: HexHash.optional(),
});
export type JoinCode = z.infer<typeof JoinCode>;

export const UploadKind = z.enum(["PHOTO", "VOICE"]);
export type UploadKind = z.infer<typeof UploadKind>;

/** A presigned simulator upload: the only way a client names S3 content (10 minutes). */
export const Upload = defineEntity("Upload", {
  uploadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  userId: ConsoleUserId,
  clockId: ClockId,
  key: S3Key,
  kind: UploadKind,
  maxBytes: z.int().min(1),
  usedAtReal: IsoInstant.optional(),
});
export type Upload = z.infer<typeof Upload>;

/** `LIVEWORLD`: the single world whose real phones get live WhatsApp (ADR-0002). */
export const LiveWorld = defineEntity("LiveWorld", {
  clockId: ClockId,
  setBy: Actor,
  setAtReal: IsoInstant,
});
export type LiveWorld = z.infer<typeof LiveWorld>;

/** `TOMB#<clockId>#<worldEpoch>`: an epoch that was reset or destroyed; its actors are purged. */
export const Tombstone = defineEntity("Tombstone", {
  clockId: ClockId,
  worldEpoch: z.int().min(0),
  reason: z.enum(["RESET", "RELOAD", "DESTROY", "JUMP", "JANITOR"]),
  atReal: IsoInstant,
});
export type Tombstone = z.infer<typeof Tombstone>;

/** `PROBE#<id>`: a checkpoint the scenario runner waits for (e.g. `PROBE#foreign#<eventId>`). Ids and times only. */
export const Probe = defineEntity("Probe", {
  probeId: z.string().regex(/^[A-Za-z0-9_.:#-]{1,300}$/),
  atReal: IsoInstant,
  detail: JsonObject.optional(),
});
export type Probe = z.infer<typeof Probe>;

/**
 * `WORLDSESSION#<clockId>`: the console session that last acted in a guest world ("one session per world",
 * routers/account.ts). Its own item, never the clock's: recording a session never moves `CLOCK#`'s version,
 * so it never races a reset, a jump or a move of the clock. 24 h.
 */
export const WorldSession = defineEntity("WorldSession", {
  clockId: ClockId,
  userId: ConsoleUserId,
  sessionId: z.string().min(1).max(128),
  atReal: IsoInstant,
});
export type WorldSession = z.infer<typeof WorldSession>;

/** The fault a client injects (a mode such as `ERROR_503` for the orchestrator, or a detailed setting). */
export const FaultSetting = z.union([z.string().min(1).max(64), JsonObject]);
export type FaultSetting = z.infer<typeof FaultSetting>;

/**
 * `FAULTS#<clockId>`: injected failures of the external clients, only for `qa-*` clocks, one
 * attribute per client (network/faults.ts reads `network`); other attributes pass through.
 */
export const Faults = defineEntity("Faults", {
  clockId: ClockId.refine((clockId) => clockId.startsWith("qa-"), "faults exist only for qa-* clocks"),
  network: FaultSetting.optional(),
  knowledge: FaultSetting.optional(),
  transcribe: FaultSetting.optional(),
  validator: FaultSetting.optional(),
}).loose();
export type Faults = z.infer<typeof Faults>;
