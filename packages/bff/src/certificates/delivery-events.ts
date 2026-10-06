// What happens to a certificate after it left (docs/architecture.md §11, FL-048, FL-049, FL-051): the
// SES events of its emails and the WhatsApp statuses of its document move `CERT.deliveries[]`, and
// the outcome tells the caller what else to do:
//
//   SES Delivery / WhatsApp delivered, read   DELIVERED / READ
//   SES Bounce Transient, DeliveryDelay       DELAYED + one CERT_RETRY (+5 simulated minutes)
//   WhatsApp failed                           FAILED + one CERT_RETRY
//   SES Bounce Permanent, Complaint           BOUNCED / COMPLAINED → the caller opens the case
//                                             CERTIFICATE_UNDELIVERED (console only, FL-051)
//
// The worker calls `recordCertificateEmailEvent` after `applyEmailEvent` (channels/email/events.ts) for
// an `EMAIL_EVENT`, and `recordCertificateMessageStatus` after a WhatsApp status moved a `CERTIFICATE`
// message. A status never moves a delivery backwards.
import type { TimerPort } from "../agent-tools/common/ports";
import type { EmailEventOutcome } from "../channels/email/events";
import type { Connector } from "../connector/ports";
import type { Message } from "../domain/conversations";
import type { CertificateDelivery, DeliveryStatus, DeliveryTarget } from "../domain/work-orders";
import type { Logger } from "../lib/log";
import { armCertRetry } from "./deliveries";

export interface DeliveryEventDeps {
  readonly connector: Pick<Connector, "workOrders">;
  readonly timers: Pick<TimerPort, "arm">;
  /** Simulated "now" of a world (the retry is due 5 simulated minutes later). */
  readonly simNow: (clockId: string) => Promise<Date>;
  readonly logger: Logger;
}

export type DeliveryEventEffect = "NONE" | "CERT_RETRY_ARMED" | "CERTIFICATE_UNDELIVERED";

export interface DeliveryEventOutcome {
  readonly recorded: boolean;
  readonly effect: DeliveryEventEffect;
  readonly delivery?: CertificateDelivery;
}

const NOTHING: DeliveryEventOutcome = { recorded: false, effect: "NONE" };

// Forward order of a delivery; outcomes (bounce, complaint, failure, denial) are final.
const RANK: Readonly<Record<DeliveryStatus, number>> = { QUEUED: 0, SENT: 1, DELAYED: 2, DELIVERED: 3, READ: 4, BOUNCED: 5, COMPLAINED: 5, FAILED: 5, DENIED: 5 };

function isForward(current: DeliveryStatus | undefined, next: DeliveryStatus): boolean {
  return current === undefined || RANK[next] > RANK[current] || (current === "FAILED" && next !== "FAILED");
}

async function record(
  deps: DeliveryEventDeps,
  workOrderId: string,
  clockId: string,
  delivery: CertificateDelivery,
  effects: { readonly retry: boolean; readonly undelivered: boolean },
): Promise<DeliveryEventOutcome> {
  const certificate = await deps.connector.workOrders.getCertificate(workOrderId);
  if (certificate === undefined) return NOTHING;
  const current = certificate.deliveries.find((existing) => existing.to === delivery.to && existing.channel === delivery.channel);
  // An event of an older send of the same recipient (the email before its retry) changes nothing.
  const sameSend = current === undefined || (delivery.mailId ?? delivery.messageId) === undefined || (current.mailId ?? current.messageId) === (delivery.mailId ?? delivery.messageId);
  if (!sameSend || !isForward(current?.status, delivery.status)) return NOTHING;
  const stored = await deps.connector.workOrders.setDelivery(workOrderId, { ...current, ...delivery });
  const log = deps.logger.child({ component: "certificate.deliveries", workOrderId });
  if (effects.retry) {
    const atSim = (await deps.simNow(clockId)).toISOString();
    await armCertRetry(deps.timers, { workOrderId, clockId }, delivery.to, atSim);
    log.info("certificate.delivery_event", { to: delivery.to, status: delivery.status, effect: "CERT_RETRY_ARMED" });
    return { recorded: true, effect: "CERT_RETRY_ARMED", delivery: stored.deliveries.find((entry) => entry.to === delivery.to) ?? delivery };
  }
  const effect: DeliveryEventEffect = effects.undelivered ? "CERTIFICATE_UNDELIVERED" : "NONE";
  log.info("certificate.delivery_event", { to: delivery.to, status: delivery.status, effect });
  return { recorded: true, effect, delivery: stored.deliveries.find((entry) => entry.to === delivery.to) ?? delivery };
}

/** An SES event of a certificate email, after `applyEmailEvent` moved its outbox row. */
export async function recordCertificateEmailEvent(deps: DeliveryEventDeps, outcome: EmailEventOutcome): Promise<DeliveryEventOutcome> {
  if (!outcome.applied || !outcome.changed) return NOTHING;
  const { mail } = outcome;
  if (mail.kind !== "CERTIFICATE_EMAIL" || mail.workOrderId === undefined || mail.toRole === "ZONE_CHIEF") return NOTHING;
  const to: DeliveryTarget = mail.toRole;
  const delivery: CertificateDelivery = {
    to,
    channel: "EMAIL",
    status: outcome.deliveryStatus,
    mailId: mail.mailId,
    updatedAtReal: mail.events.at(-1)?.atReal ?? mail.sentAtReal,
  };
  return record(deps, mail.workOrderId, mail.clockId, delivery, {
    retry: outcome.effect === "SCHEDULE_CERT_RETRY",
    undelivered: outcome.effect === "CERTIFICATE_UNDELIVERED",
  });
}

const MESSAGE_STATUS: Readonly<Partial<Record<Message["status"], DeliveryStatus>>> = { SENT: "SENT", DELIVERED: "DELIVERED", READ: "READ", FAILED: "FAILED" };

/** A WhatsApp status of the certificate sent to the installer (document or template). */
export async function recordCertificateMessageStatus(deps: DeliveryEventDeps, message: Message, atReal: string): Promise<DeliveryEventOutcome> {
  if (message.direction !== "OUT" || message.kind !== "CERTIFICATE" || message.workOrderId === undefined) return NOTHING;
  const status = MESSAGE_STATUS[message.status];
  if (status === undefined) return NOTHING;
  const delivery: CertificateDelivery = { to: "INSTALLER", channel: "WHATSAPP", status, messageId: message.messageId, updatedAtReal: atReal };
  return record(deps, message.workOrderId, message.clockId, delivery, { retry: status === "FAILED", undelivered: false });
}
