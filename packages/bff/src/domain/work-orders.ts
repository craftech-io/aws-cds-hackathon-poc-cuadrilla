// `WorkOrders` table (docs/architecture.md §5): the order and, in its partition, the closing
// checklist, the evidence photos, their validations, the troubleshooting steps and the installation
// certificate. Timers that live in the same partition are in domain/timers.ts. Every business instant
// is simulated (`…Sim`) and belongs to the world clock of the order.
import { z } from "zod";
import {
  CalendarDate,
  ChecklistItem,
  ChecklistItemStatus,
  ClockId,
  ConsoleUserId,
  CrewId,
  CustomerId,
  EvidenceId,
  InstallerId,
  IsoInstant,
  IspId,
  OnuOperState,
  OnuSerial,
  OpticalClass,
  PhotoId,
  PhotoItem,
  RejectReason,
  RuleId,
  SendChannel,
  StepOutcome,
  Symptom,
  ValidationId,
  Verdict,
  WorkOrderId,
  WorkOrderNumber,
  WorkOrderStatus,
  ZoneId,
} from "@cuadrilla/shared";
import { HistoryEntry, JsonObject, NonEmptyText, S3Key, Sha256Hex, TokenUsage, defineEntity } from "./common";

export const AppointmentWindow = z
  .object({ startSim: IsoInstant, endSim: IsoInstant })
  .refine((window) => Date.parse(window.startSim) < Date.parse(window.endSim), "the window must end after it starts");
export type AppointmentWindow = z.infer<typeof AppointmentWindow>;

/** A reading of the ONU the order keeps (`close_installation` needs one of the last 30 simulated minutes). */
export const OnuReading = z.object({
  operState: OnuOperState,
  rxPowerDbm: z.number().optional(),
  txPowerDbm: z.number().optional(),
  inRange: z.boolean(),
  observedAtSim: IsoInstant,
  source: z.enum(["AGENT", "CLOSE", "WORKER", "CONSOLE", "QA"]),
});
export type OnuReading = z.infer<typeof OnuReading>;

/** Why a visit failed (`close_installation` with `FAILED_VISIT`). */
export const FailedVisitReason = z.enum(["CUSTOMER_ABSENT", "ACCESS_DENIED", "SAFETY_UNRESOLVED", "OTHER"]);
export type FailedVisitReason = z.infer<typeof FailedVisitReason>;

export const WorkOrder = defineEntity("WorkOrder", {
  workOrderId: WorkOrderId,
  workOrderNumber: WorkOrderNumber,
  ispId: IspId,
  clockId: ClockId,
  worldEpoch: z.int().min(0),
  /** Raised after a G1 block of the Harness: a new AgentCore session for the order. */
  sessionEpoch: z.int().min(0).default(0),
  installerId: InstallerId,
  customerId: CustomerId,
  crewId: CrewId,
  zoneId: ZoneId,
  /** Simulated calendar day of the appointment (America/Mexico_City). */
  date: CalendarDate,
  appointmentWindow: AppointmentWindow,
  plan: NonEmptyText.max(80),
  onuSerial: OnuSerial,
  onuModel: NonEmptyText.max(80),
  oltPort: NonEmptyText.max(40),
  opticalClass: OpticalClass,
  status: WorkOrderStatus,
  onHoldSafety: z.boolean().default(false),
  lastOnuReading: OnuReading.optional(),
  closedAtSim: IsoInstant.optional(),
  failedReason: FailedVisitReason.optional(),
  history: z.array(HistoryEntry).default([]),
});
export type WorkOrder = z.infer<typeof WorkOrder>;

/** Who validated an item by hand (ADR-0011): always a person with a recent console login. */
export const ManualOverride = z.object({ userId: ConsoleUserId, reason: NonEmptyText.max(500), atSim: IsoInstant });
export type ManualOverride = z.infer<typeof ManualOverride>;

/** One item of the closing checklist (manual §EVI-01); `attempts` counts rejected photos. */
export const ChecklistEntry = defineEntity("ChecklistItem", {
  workOrderId: WorkOrderId,
  clockId: ClockId,
  item: ChecklistItem,
  status: ChecklistItemStatus,
  attempts: z.int().min(0).default(0),
  lastRejectReason: RejectReason.optional(),
  validationId: ValidationId.optional(),
  evidenceId: EvidenceId.optional(),
  override: ManualOverride.optional(),
  updatedAtSim: IsoInstant.optional(),
  history: z.array(HistoryEntry).default([]),
});
export type ChecklistEntry = z.infer<typeof ChecklistEntry>;

/**
 * A photo kept as evidence for a checklist item: JPEG without metadata in `Evidence/photos/`.
 * `sha256` plus the world and its epoch make `GSI4`, the repeated-photo check (`DUPLICATE_EVIDENCE`).
 */
export const Evidence = defineEntity("Evidence", {
  evidenceId: EvidenceId,
  workOrderId: WorkOrderId,
  clockId: ClockId,
  worldEpoch: z.int().min(0),
  item: PhotoItem,
  sha256: Sha256Hex,
  s3Key: S3Key,
  mime: z.literal("image/jpeg"),
  bytes: z.int().min(1),
  /** Inbound message the candidate photo came in (`LAM-CANDIDATE`). */
  sourceMessageId: z.string().min(1).max(128).optional(),
  /** Photo of the synthetic set or seeding render a preset used (`ph-seed-…`, `ph-hist-…`). */
  photoId: PhotoId.optional(),
  receivedAtSim: IsoInstant,
});
export type Evidence = z.infer<typeof Evidence>;

export const PhotoReadings = z.object({
  readingDbm: z.number().optional(),
  wavelengthNm: z.number().optional(),
  serial: z.string().max(64).optional(),
  serialMatches: z.boolean().optional(),
});
export type PhotoReadings = z.infer<typeof PhotoReadings>;

/** Where a verdict came from: the isolated model call, the scripted fake (U/LF), the seed. */
export const ValidationSource = z.enum(["MODEL", "SCRIPTED", "SEED"]);
export type ValidationSource = z.infer<typeof ValidationSource>;

/** Result of `validate_install_photo`: the final verdict after the deterministic checks (ADR-0015). */
export const PhotoValidation = defineEntity("PhotoValidation", {
  validationId: ValidationId,
  workOrderId: WorkOrderId,
  clockId: ClockId,
  item: PhotoItem,
  evidenceId: EvidenceId.optional(),
  candidateId: z.string().min(1).max(128).optional(),
  sha256: Sha256Hex.optional(),
  verdict: Verdict,
  modelVerdict: z.enum(["PASS", "REJECT"]).optional(),
  reasonCode: RejectReason.optional(),
  readings: PhotoReadings.default({}),
  /** Deterministic checks that hardened the verdict (`VAL-RANGE`, `VAL-SERIAL`…). */
  checks: z.array(RuleId).default([]),
  confidence: z.number().min(0).max(1).optional(),
  rubricVersion: z.string().regex(/^v\d{3}$/).optional(),
  stopReason: z.string().max(64).optional(),
  usage: TokenUsage.optional(),
  latencyMs: z.int().min(0).optional(),
  source: ValidationSource,
  atSim: IsoInstant,
});
export type PhotoValidation = z.infer<typeof PhotoValidation>;

/** A manual section id, optionally with a sub-step (`DIAG-02`, `DIAG-02-a`). */
export const StepRef = z.string().regex(/^(?:GEN|SEG|INS|MED|DIAG|EVI|COM|ESC|CAL)-\d{2}(?:-[a-z0-9]{1,8})?$/, "expected a manual section such as DIAG-02");
export type StepRef = z.infer<typeof StepRef>;

/** A troubleshooting step the agent indicated and its outcome (`record_troubleshooting_step`). */
export const TroubleshootingStep = defineEntity("TroubleshootingStep", {
  workOrderId: WorkOrderId,
  clockId: ClockId,
  seq: z.int().min(1).max(999),
  symptom: Symptom,
  stepRef: StepRef,
  outcome: StepOutcome,
  recordedAtSim: IsoInstant,
  turnId: z.string().min(1).max(128).optional(),
  history: z.array(HistoryEntry).default([]),
});
export type TroubleshootingStep = z.infer<typeof TroubleshootingStep>;

export const DeliveryTarget = z.enum(["CUSTOMER", "OPS_MAILBOX", "INSTALLER"]);
export type DeliveryTarget = z.infer<typeof DeliveryTarget>;

export const DeliveryStatus = z.enum(["QUEUED", "SENT", "DELIVERED", "READ", "DELAYED", "BOUNCED", "COMPLAINED", "FAILED", "DENIED"]);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/** Delivery of the certificate to one recipient, fed by SES events and WhatsApp statuses. */
export const CertificateDelivery = z.object({
  to: DeliveryTarget,
  channel: SendChannel,
  status: DeliveryStatus,
  messageId: z.string().min(1).max(128).optional(),
  mailId: z.string().min(1).max(128).optional(),
  updatedAtSim: IsoInstant.optional(),
  updatedAtReal: IsoInstant.optional(),
  detail: z.string().max(200).optional(),
});
export type CertificateDelivery = z.infer<typeof CertificateDelivery>;

/**
 * The installation certificate. `content` is what the PDF shows (built from the order, never from
 * model text); historical certificates of the seed carry only `content`, and the world factory
 * renders their PDF and fills `sha256`/`s3Key` with the brand of the world (ADR-0018).
 */
export const Certificate = defineEntity("Certificate", {
  workOrderId: WorkOrderId,
  clockId: ClockId,
  certificateId: z.string().regex(/^cert-[A-Za-z0-9-]{1,120}$/, "expected cert-<id>"),
  n: z.int().min(1),
  issuedAtSim: IsoInstant,
  sha256: Sha256Hex.optional(),
  s3Key: S3Key.optional(),
  content: JsonObject.optional(),
  deliveries: z.array(CertificateDelivery).default([]),
});
export type Certificate = z.infer<typeof Certificate>;
