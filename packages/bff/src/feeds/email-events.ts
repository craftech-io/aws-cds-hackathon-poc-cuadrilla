// What `ChannelEvents` does with an SES event of the configuration set (docs/architecture-integrations.md
// §1 "Pendiente" and §2): the rule of infra/messaging-email.ts already keeps only `aws.ses` events of our
// configuration set that carry a `mailId` tag; this module trusts none of that and parses again
// (channels/email/events.ts `parseSesEvent`).
//
//   - Not ours (another set, an untracked type, foreign tags): ignored. A lead notice (`kind
//     LEAD_NOTIFY`) that bounced, was complained about or failed adds `LeadNotifyFailures` to the log.
//     Cognito's emails carry no tag and never get here.
//   - Ours without `EmailTags.workOrderId`, of an order that does not exist, or a `Send` (the status the
//     email already has, never an effect): no installer has to act, so the outbox row and the world's
//     pending mark move here and nothing is queued.
//   - Ours with an order: `EMAIL_EVENT` with the parsed record on the group of the order's installer
//     (`inFlight` first), where `apply_email_event` moves the outbox row and the certificate delivery and
//     applies the effect once; then the world's pending mark of the email closes (`PENDING#…MAIL#`,
//     the first event about the recipient). The world is never quiet in between. Once the queue took
//     it, `IDEMP#ses-event-queued#<eventId>` turns a redelivery into a duplicate that marks nothing.
//
// No address and no content ever reaches a log line.
import { z } from "zod";
import type { Connector } from "../connector/ports";
import { LEAD_NOTICE_KIND } from "../copy/lead-notify";
import { type EmailEventRecord, applyEmailEvent, parseSesEvent } from "../channels/email/events";
import type { Logger } from "../lib/log";
import { type QueueSink, sesEventId } from "./queue-events";

export type EmailEventsOutcome = "IGNORED" | "LEAD_NOTICE_FAILURE" | "SENT_APPLIED" | "NO_WORK_ORDER" | "UNKNOWN_ORDER" | "UNKNOWN_MAIL" | "DUPLICATE" | "QUEUED";

export interface EmailEventsDeps {
  readonly connector: Pick<Connector, "conversations" | "workOrders" | "runtime" | "worlds">;
  readonly queue: QueueSink;
  /** `<app>-email-<stage>`: the only configuration set whose events are ours. */
  readonly configurationSetName: string;
  readonly logger: Logger;
}

/** Written once the queue took an email event: a later redelivery is a duplicate. */
export const SES_EVENT_QUEUED = "ses-event-queued";

const FAILURE_TYPES = new Set(["Bounce", "Complaint", "Reject", "Rendering Failure", "RenderingFailure"]);

const LeadNoticeEvent = z.object({
  detail: z.object({ eventType: z.string().max(64), mail: z.object({ tags: z.record(z.string(), z.array(z.string())).default({}) }) }),
});

/** An event of the lead notice that did not reach its mailbox; only the event type is kept. */
function leadNoticeFailure(raw: unknown, configurationSetName: string): string | undefined {
  const parsed = LeadNoticeEvent.safeParse(raw);
  if (!parsed.success) return undefined;
  const { eventType, mail } = parsed.data.detail;
  const ours = mail.tags["ses:configuration-set"]?.[0] === configurationSetName && mail.tags.kind?.[0] === LEAD_NOTICE_KIND;
  return ours && FAILURE_TYPES.has(eventType) ? eventType : undefined;
}

/** Moves the outbox row and the pending mark of an email no installer has to act on. */
async function applyHere(record: EmailEventRecord, outcome: "SENT_APPLIED" | "NO_WORK_ORDER" | "UNKNOWN_ORDER", deps: EmailEventsDeps): Promise<EmailEventsOutcome> {
  const applied = await applyEmailEvent(deps.connector, record);
  deps.logger.info("channel_events.applied_without_queue", { outcome, type: record.type, kind: record.kind, mailId: record.mailId, applied: applied.applied });
  return applied.applied ? outcome : "UNKNOWN_MAIL";
}

async function queueForInstaller(record: EmailEventRecord, installerId: string, deps: EmailEventsDeps): Promise<EmailEventsOutcome> {
  const eventId = sesEventId(record.providerMessageId, record.type, record.atReal);
  if ((await deps.connector.runtime.getIdempotency(SES_EVENT_QUEUED, eventId)) !== undefined) return "DUPLICATE";
  await deps.queue.enqueue({ type: "EMAIL_EVENT", eventId, clockId: record.clockId, ispId: record.ispId, installerId, record });
  // Claimed before anything else can fail: a retry that enqueued again would mark the event in flight
  // after the worker cleared it, and FIFO deduplication would drop that copy (the world never settles).
  await deps.connector.runtime.claimIdempotency(SES_EVENT_QUEUED, eventId);
  await deps.connector.worlds.closePendingMail(record.clockId, record.mailId, record.type);
  return "QUEUED";
}

/** One EventBridge event of the configuration set. Throws only when a dependency failed (EventBridge retries). */
export async function processEmailEvent(raw: unknown, deps: EmailEventsDeps): Promise<EmailEventsOutcome> {
  const parsed = parseSesEvent(raw, deps.configurationSetName);
  if (!parsed.ok) {
    const leadFailure = leadNoticeFailure(raw, deps.configurationSetName);
    if (leadFailure !== undefined) {
      deps.logger.error("lead.notice.undelivered", { metric: "LeadNotifyFailures", value: 1, eventType: leadFailure });
      return "LEAD_NOTICE_FAILURE";
    }
    deps.logger.info("channel_events.ignored", { ignored: parsed.ignored });
    return "IGNORED";
  }
  const { record } = parsed;
  if (record.type === "SEND") return applyHere(record, "SENT_APPLIED", deps);
  if (record.workOrderId === undefined) return applyHere(record, "NO_WORK_ORDER", deps);
  const order = await deps.connector.workOrders.getWorkOrder(record.workOrderId);
  if (order === undefined || order.ispId !== record.ispId) return applyHere(record, "UNKNOWN_ORDER", deps);
  const outcome = await queueForInstaller(record, order.installerId, deps);
  deps.logger.info("channel_events.done", { outcome, type: record.type, kind: record.kind, mailId: record.mailId, workOrderId: record.workOrderId });
  return outcome;
}
