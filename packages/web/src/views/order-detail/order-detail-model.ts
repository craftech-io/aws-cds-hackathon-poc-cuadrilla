// The detail of a work order (`/app/orders/:workOrderId`, docs/design-brief.md §6; FL-080, FL-044)
// without React: the contracts of `orders.get`, `orders.timeline` and `orders.onuStatus` checked with zod
// at the edge, the manual section a citation links to, who may validate an item by hand, and the
// timeline grouped by simulated time. Tested in order-detail-model.test.ts.
import { z } from "zod";
import {
  AuditDecision,
  CaseReason,
  CaseStatus,
  ChecklistItem,
  ChecklistItemStatus,
  type ConsoleRole,
  OnuOperState,
  PhotoItem,
  RejectReason,
  Rung,
  StepOutcome,
  Symptom,
  Verdict,
} from "@cuadrilla/shared";
import { SimInstant } from "../../lib/world-clock";
import { CONSOLE_PREFIX } from "../../routes";
import { OrderRow } from "../orders/orders-model";

export const DETAIL_PROCEDURES = {
  get: "orders.get",
  timeline: "orders.timeline",
  onuStatus: "orders.onuStatus",
  mediaUrl: "orders.mediaUrl",
  certificateUrl: "orders.certificateUrl",
} as const;

const Range = z.object({ minDbm: z.number(), maxDbm: z.number() });

export const ChecklistEntryView = z.object({
  item: ChecklistItem,
  status: ChecklistItemStatus,
  attempts: z.number().int().min(0),
  lastRejectReason: RejectReason.nullable(),
  evidenceId: z.string().nullable(),
  override: z.object({ by: z.string(), reason: z.string(), atSim: SimInstant }).nullable(),
});
export type ChecklistEntryView = z.infer<typeof ChecklistEntryView>;

const Delivery = z.object({ to: z.string(), channel: z.string(), status: z.string(), updatedAtSim: SimInstant.optional() });

/** `orders.get` (packages/bff/src/routers/orders.ts, `detailOf`). */
export const OrderDetail = OrderRow.extend({
  onuSerial: z.string(),
  opticalClass: z.string(),
  customer: z.object({ firstName: z.string(), lastName: z.string(), addressLine: z.string(), neighborhood: z.string() }).nullable(),
  acceptanceRange: Range.nullable(),
  checklist: z.array(ChecklistEntryView),
  cases: z.array(z.object({ caseId: z.string(), reason: CaseReason, status: CaseStatus, rung: Rung, createdAtSim: SimInstant })),
  certificate: z.object({ n: z.number().int(), issuedAtSim: SimInstant, available: z.boolean(), deliveries: z.array(Delivery) }).nullable(),
  closedAtSim: SimInstant.nullable(),
});
export type OrderDetail = z.infer<typeof OrderDetail>;

const MessageEntry = z.object({
  type: z.literal("MESSAGE"),
  atSim: SimInstant,
  messageId: z.string(),
  direction: z.enum(["IN", "OUT"]),
  content: z.string(),
  kind: z.string().nullable(),
  author: z.string(),
  text: z.string().nullable(),
  templateName: z.string().nullable(),
  buttonAction: z.string().nullable(),
  transcript: z.object({ text: z.string(), confidence: z.number() }).nullable(),
  hasMedia: z.boolean(),
  mediaKind: z.enum(["AUDIO", "IMAGE", "DOCUMENT"]).nullable(),
  status: z.string(),
  citations: z.array(z.string()),
  ruleIds: z.array(z.string()),
  decision: AuditDecision.nullable(),
});
const EmailEntry = z.object({ type: z.literal("EMAIL"), atSim: SimInstant, mailId: z.string(), kind: z.string(), toRole: z.string(), subject: z.string(), status: z.string(), hasAttachment: z.boolean() });
const NoteEntry = z.object({ type: z.literal("TURN_NOTE"), atSim: SimInstant, turnId: z.string(), trigger: z.string(), note: z.string() });
const ValidationEntry = z.object({
  type: z.literal("VALIDATION"),
  atSim: SimInstant,
  validationId: z.string(),
  item: PhotoItem,
  verdict: Verdict,
  reasonCode: RejectReason.nullable(),
  checks: z.array(z.string()),
  evidenceId: z.string().nullable(),
});
const StepEntry = z.object({ type: z.literal("STEP"), atSim: SimInstant, seq: z.number().int(), symptom: Symptom, stepRef: z.string(), outcome: StepOutcome });
const DecisionEntry = z.object({
  type: z.literal("DECISION"),
  atSim: SimInstant,
  decisionId: z.string(),
  decision: AuditDecision,
  action: z.string(),
  ruleIds: z.array(z.string()),
  trigger: z.string().nullable(),
});

export const TimelineEntry = z.discriminatedUnion("type", [MessageEntry, EmailEntry, NoteEntry, ValidationEntry, StepEntry, DecisionEntry]);
export type TimelineEntry = z.infer<typeof TimelineEntry>;
export type MessageEntry = z.infer<typeof MessageEntry>;

/** `orders.timeline`: the entries by simulated time and what is still pending (timers, deferred sends). */
export const Timeline = z.object({
  workOrderId: z.string(),
  entries: z.array(TimelineEntry),
  pending: z.array(z.object({ kind: z.string(), dueAtSim: SimInstant, reason: z.string().nullable() })),
});
export type Timeline = z.infer<typeof Timeline>;

/** `orders.onuStatus`: the ONU right now in the simulated network, or why it cannot be read. */
export const OnuStatus = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true), operState: OnuOperState, rxPowerDbm: z.number().nullable(), inRange: z.boolean(), acceptanceRange: Range.nullable() }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);
export type OnuStatus = z.infer<typeof OnuStatus>;

export const MediaLink = z.object({ url: z.string().min(1), contentType: z.string() });
export const CertificateLink = z.object({ url: z.string().min(1) });

/** Input of `orders.mediaUrl`: a message of the timeline or an evidence photo. */
export type MediaRef = { readonly messageId: string } | { readonly evidenceId: string };

/** Photo items a person may validate by hand, in the states the BFF accepts (ADR-0011). */
const REVIEWABLE: ReadonlySet<ChecklistItemStatus> = new Set(["REJECTED", "IN_REVIEW"]);
const OPEN_ORDER: ReadonlySet<string> = new Set(["SCHEDULED", "IN_PROGRESS"]);
const PHOTO_ITEMS: ReadonlySet<string> = new Set(PhotoItem.options);

/** Supervisors and guests validate by hand; operations staff only look (`supervisorProcedure`). */
export function canValidate(role: ConsoleRole | undefined): boolean {
  return role === "SUPERVISOR" || role === "GUEST";
}

/** The item can be validated by hand right now: a photo, rejected or in review, of an open order. */
export function isReviewable(entry: Pick<ChecklistEntryView, "item" | "status">, orderStatus: string): boolean {
  return PHOTO_ITEMS.has(entry.item) && REVIEWABLE.has(entry.status) && OPEN_ORDER.has(orderStatus);
}

/** `DIAG-02` → the manual view at that section; anything that is not a section id has no link. */
export function manualHref(sectionId: string): string | undefined {
  return /^[A-Z]{2,4}-\d{2}$/.test(sectionId) ? `${CONSOLE_PREFIX}/manual/${sectionId}` : undefined;
}

/** "§DIAG-02". */
export function sectionLabel(sectionId: string): string {
  return `§${sectionId}`;
}

/** Who wrote a message: the installer, a supervisor (a person of the thread), the assistant or the system. */
export type Speaker = "INSTALLER" | "PERSON" | "AGENT" | "SYSTEM";

export function speakerOf(entry: Pick<MessageEntry, "direction" | "author">, installerId: string | undefined): Speaker {
  if (entry.author === "AGENT") return "AGENT";
  if (entry.author === "SYSTEM") return "SYSTEM";
  if (entry.direction === "IN" && installerId !== undefined && entry.author === `PERSON:${installerId}`) return "INSTALLER";
  return entry.direction === "IN" ? "INSTALLER" : "PERSON";
}

/** Entries whose content is for machines only (read receipts) stay out of the timeline a person reads. */
export function visibleEntries(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return entries.filter((entry) => !(entry.type === "MESSAGE" && (entry.content === "READ_ACK" || entry.kind === "READ_ACK")));
}

/** The key of an entry, unique within a timeline. */
export function entryKey(entry: TimelineEntry): string {
  switch (entry.type) {
    case "MESSAGE":
      return `m-${entry.messageId}`;
    case "EMAIL":
      return `e-${entry.mailId}`;
    case "TURN_NOTE":
      return `t-${entry.turnId}`;
    case "VALIDATION":
      return `v-${entry.validationId}`;
    case "STEP":
      return `s-${entry.seq}`;
    case "DECISION":
      return `d-${entry.decisionId}`;
  }
}

/** Counts per kind for the timeline's filter pills. */
export type TimelineFilter = "ALL" | "MESSAGES" | "EVIDENCE" | "DECISIONS";

export function matchesTimeline(entry: TimelineEntry, filter: TimelineFilter): boolean {
  switch (filter) {
    case "ALL":
      return true;
    case "MESSAGES":
      return entry.type === "MESSAGE" || entry.type === "EMAIL";
    case "EVIDENCE":
      return entry.type === "VALIDATION" || entry.type === "STEP";
    case "DECISIONS":
      return entry.type === "DECISION" || entry.type === "TURN_NOTE";
  }
}
