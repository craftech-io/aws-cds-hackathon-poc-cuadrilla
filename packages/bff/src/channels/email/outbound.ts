// The single SES v2 client (docs/architecture-integrations.md §1): every email of the system goes out
// here, so the fence lives inside the client and no path can forget it. One send, in order:
//
//   1. the request (zod) and its content: subject and body from copy/, no foreign link or address;
//   2. an id already sent is answered from the outbox and never sent twice;
//   3. `CP-RECIPIENT-FENCE` of the world (outbound/recipient-fence.ts) plus the addresses that
//      bounced permanently or complained before: `RECIPIENT_NOT_ALLOWED`, audited, SES never called;
//   4. the world's email cap (`SIMCAP#<clockId>#emails#<realDay>`, ops/cost-caps.ts): `CAP_REACHED`;
//   5. the certificate PDF, checked against its `sha256`;
//   6. `Runtime/PENDING#<clockId>` · `MAIL#<mailId>` (the world is busy until SES answers) and the
//      outbox row `QUEUED` with the body as it leaves;
//   7. `SendEmail`; the row becomes `SENT` with SES's message id, or `FAILED` (the pending mark is
//      closed and the cap given back, so a retry starts clean: a resend of the same id reopens the
//      mark and puts the row back to `QUEUED` before calling SES again).
//
// The SES events move the row afterwards (channels/email/events.ts). `probe` answers `fence.probe` of
// the QaDriver: the same decision, without sending.
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { ChannelError, ispIdOfClock } from "@cuadrilla/shared";
import type { Connector } from "../../connector/ports";
import type { Actor } from "../../domain/common";
import type { OutboundEmail } from "../../domain/conversations";
import { type Clock, systemClock } from "../../lib/clock";
import { ulid } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import { type CostAuditEvent, type CostCapsDeps, type GlobalCostCaps, releaseCost, reserveCost } from "../../ops/cost-caps";
import { FENCE_RULE, type FenceDecision, fenceEmailRecipient } from "../../outbound/recipient-fence";
import { type ChannelSendFailure, type ChannelSendResult, type ChannelTransport, sendFailure } from "../adapter";
import { type AttachmentReader, loadCertificatePdf } from "./attachments";
import type { EmailChannelConfig } from "./config";
import { assertEmailContent } from "./content";
import { nextStatus } from "./events";
import { EmailSendRequest, type EmailSendRequestInput, buildSendEmailInput, displayFrom } from "./request";

export interface EmailClientDeps {
  readonly connector: Pick<Connector, "isps" | "conversations" | "worlds" | "audit">;
  readonly ses: Pick<SESv2Client, "send">;
  readonly attachments: AttachmentReader;
  readonly config: () => EmailChannelConfig;
  /** `SeedOverrides.demoRecipients.emails`, read lazily (PII: never logged). */
  readonly demoRecipients: () => readonly string[];
  /** `Runtime` store of the cap counters (ops/defaults.ts `runtimeStore`). */
  readonly caps: Pick<CostCapsDeps, "store">;
  /** Real time: `sentAtReal`, caps and pending marks. */
  readonly realClock?: Clock;
  readonly newMailId?: () => string;
  readonly logger: Logger;
}

export type EmailSendOutcome = ChannelSendResult<{ readonly mailId: string; readonly providerMessageId: string; readonly mail: OutboundEmail; readonly duplicate: boolean }>;

export interface EmailClient extends ChannelTransport<EmailSendRequestInput, EmailSendOutcome> {
  /** `fence.probe`: the fence of the world for each address, audited like a send, nothing sent. */
  probe(clockId: string, addresses: readonly string[], actor: Actor): Promise<FenceDecision[]>;
}

/**
 * Emails are capped per world only (`SIMCAP#…#emails`, ADR-0019): the client reserves the SIMULATOR
 * ledger alone, so the stage's ceiling is never planned and no sending Lambda needs the `CostCaps` link.
 */
const NO_STAGE_CEILING: GlobalCostCaps = { turnsPerDay: 0, validationsPerDay: 0, transcribeSecondsPerDay: 0 };

/** Statuses that take an address out of the fence for good (FL-051: no automatic resend to it). */
const SUPPRESSING = new Set<OutboundEmail["status"]>(["BOUNCED", "COMPLAINED"]);
const OUTBOX_SCAN = 500;

// SES v2 error names (dist-types/models/errors.d.ts). The SDK already retried throttling and
// transient errors with backoff within its own budget; this only tells the caller whether a later
// retry (`CERT_RETRY`) may succeed.
const NOT_RETRYABLE = new Set(["MessageRejected", "AccountSuspendedException", "SendingPausedException", "MailFromDomainNotVerifiedException", "BadRequestException", "NotFoundException"]);

export function sesFailure(error: unknown): ChannelSendFailure {
  const name = error instanceof Error ? error.name : "Unknown";
  if (error instanceof ChannelError) return sendFailure(error.code === "INVALID" ? "INVALID" : "UNAVAILABLE", error.code, { retryable: error.retryable });
  if (name === "BadRequestException") return sendFailure("INVALID", name);
  return sendFailure("UNAVAILABLE", name, { retryable: !NOT_RETRYABLE.has(name) });
}

/** A send or a probe the client refused, as `AuditLog` records it (ids only, never the address). */
interface DeniedAudit {
  readonly clockId: string;
  readonly action: "SEND_EMAIL" | "FENCE_PROBE";
  readonly ruleIds: readonly string[];
  readonly reason: string;
  readonly actor: Actor;
  readonly atSim?: string;
  readonly refs?: Readonly<Record<string, string | undefined>>;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export function createEmailClient(deps: EmailClientDeps): EmailClient {
  const realClock = deps.realClock ?? systemClock;
  const newMailId = deps.newMailId ?? (() => `mail-${ulid()}`);
  const { connector } = deps;

  async function suppressed(ispId: string, address: string): Promise<boolean> {
    const outbox = await connector.conversations.listOutbox(ispId, { limit: OUTBOX_SCAN, descending: true });
    return outbox.some((mail) => mail.to === address && SUPPRESSING.has(mail.status));
  }

  async function fence(raw: string, clockId: string): Promise<FenceDecision> {
    const decision = fenceEmailRecipient(raw, clockId, { demoRecipients: deps.demoRecipients() });
    if (!decision.allowed || !(await suppressed(ispIdOfClock(clockId), decision.address))) return decision;
    return { allowed: false, ruleId: FENCE_RULE, reason: "SUPPRESSED" };
  }

  async function auditDenied(input: DeniedAudit): Promise<void> {
    const refs = Object.fromEntries(Object.entries(input.refs ?? {}).filter(([, value]) => value !== undefined));
    await connector.audit.append({
      ispId: ispIdOfClock(input.clockId),
      clockId: input.clockId,
      ...(input.atSim === undefined ? {} : { atSim: input.atSim }),
      decision: "DENY",
      action: input.action,
      ruleIds: input.ruleIds,
      actor: input.actor,
      refs,
      reason: input.reason,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    });
  }

  async function send(input: EmailSendRequestInput): Promise<EmailSendOutcome> {
    const parsed = EmailSendRequest.safeParse(input);
    if (!parsed.success) return sendFailure("INVALID", "REQUEST");
    const request = parsed.data;
    const ispId = ispIdOfClock(request.clockId);
    const config = deps.config();
    const log = deps.logger.child({ component: "email", kind: request.kind, toRole: request.toRole, workOrderId: request.workOrderId });
    try {
      assertEmailContent(request.subject, request.bodyText, { kind: request.kind, identityDomain: config.identityDomain, caseId: request.caseId });
    } catch (error) {
      log.warn("email content refused", { error });
      return sendFailure("INVALID", "CONTENT");
    }

    const existing = request.mailId === undefined ? undefined : await connector.conversations.findMail(ispId, request.mailId);
    if (existing?.providerMessageId !== undefined) return { ok: true, mailId: existing.mailId, providerMessageId: existing.providerMessageId, mail: existing, duplicate: true };
    const mailId = existing?.mailId ?? request.mailId ?? newMailId();
    const refs = { workOrderId: request.workOrderId, caseId: request.caseId, mailId };

    const decision = await fence(request.to, request.clockId);
    if (!decision.allowed) {
      log.warn("email recipient outside the fence", { mailId, reason: decision.reason, addressError: decision.addressError });
      await auditDenied({ clockId: request.clockId, action: "SEND_EMAIL", ruleIds: [FENCE_RULE], reason: decision.reason, actor: request.actor, atSim: request.sentAtSim, refs, detail: { kind: request.kind, toRole: request.toRole } });
      return sendFailure("RECIPIENT_NOT_ALLOWED", decision.reason);
    }

    const settings = await connector.isps.getSettings(ispId);
    const capAudit = async (event: CostAuditEvent) => auditDenied({ clockId: request.clockId, action: "SEND_EMAIL", ruleIds: [], reason: event.code, actor: request.actor, atSim: request.sentAtSim, refs, detail: { resource: event.resource } });
    const cap = await reserveCost({ store: deps.caps.store, globalCaps: () => NO_STAGE_CEILING, realClock, audit: capAudit, logger: log }, { world: { clockId: request.clockId, settings }, resource: "emails", amount: 1, reserve: ["SIMULATOR"] });
    if (!cap.ok) return cap.code === "CAP_REACHED" ? sendFailure("CAP_REACHED", cap.counter.ledger, { resetsAtReal: cap.counter.resetsAtReal }) : sendFailure("UNAVAILABLE", cap.code, { retryable: true });

    const release = () => releaseCost(deps.caps, cap.reserved);
    let commandInput;
    try {
      const pdf = request.attachment === undefined ? undefined : await loadCertificatePdf(deps.attachments, request.attachment);
      commandInput = buildSendEmailInput({ request, to: decision.address, mailId, config, pdf });
    } catch (error) {
      await release();
      log.warn("email not built", { mailId, error });
      return sesFailure(error);
    }

    const sentAtReal = (await realClock.now()).toISOString();
    await connector.worlds.addPendingMail(request.clockId, mailId);
    // A resend of a mail whose send failed: the row starts over as QUEUED, so SENT and SES's events move it again.
    const retried = existing?.status === "FAILED" ? await connector.conversations.updateMail({ ispId, sentAtSim: existing.sentAtSim, mailId }, { status: "QUEUED" }) : existing;
    const mail =
      retried ??
      (await connector.conversations.appendMail({
        mailId,
        ispId,
        clockId: request.clockId,
        kind: request.kind,
        toRole: request.toRole,
        to: decision.address,
        from: displayFrom(request, config),
        subject: request.subject,
        bodyText: request.bodyText,
        workOrderId: request.workOrderId,
        ...(request.caseId === undefined ? {} : { caseId: request.caseId }),
        ...(request.attachment === undefined ? {} : { attachment: { s3Key: request.attachment.s3Key, fileName: request.attachment.fileName, contentType: "application/pdf" as const, ...(request.attachment.sha256 === undefined ? {} : { sha256: request.attachment.sha256 }) } }),
        status: "QUEUED",
        sentAtSim: request.sentAtSim,
        sentAtReal,
      }));
    const ref = { ispId, sentAtSim: mail.sentAtSim, mailId };

    let providerMessageId: string | undefined;
    let failure: ChannelSendFailure | undefined;
    try {
      providerMessageId = (await deps.ses.send(new SendEmailCommand(commandInput))).MessageId;
    } catch (error) {
      failure = sesFailure(error);
      log.error("ses send failed", { mailId, error });
    }
    if (providerMessageId === undefined) {
      await connector.conversations.updateMail(ref, { status: "FAILED" });
      await connector.worlds.closePendingMail(request.clockId, mailId, "SEND_FAILED");
      await release();
      return failure ?? sendFailure("UNAVAILABLE", "NO_MESSAGE_ID", { retryable: true });
    }
    // An SES event may have moved the row already (events.ts): the status never goes back.
    const current = await connector.conversations.getMail(ref);
    const sent = await connector.conversations.updateMail(ref, { status: nextStatus(current?.status ?? "QUEUED", "SENT"), providerMessageId });
    log.info("email sent", { mailId, providerMessageId, recipientClass: decision.recipientClass, attachment: request.attachment !== undefined });
    return { ok: true, mailId, providerMessageId, mail: sent, duplicate: false };
  }

  async function probe(clockId: string, addresses: readonly string[], actor: Actor): Promise<FenceDecision[]> {
    const decisions: FenceDecision[] = [];
    for (const address of addresses) {
      const decision = await fence(address, clockId);
      if (!decision.allowed) await auditDenied({ clockId, action: "FENCE_PROBE", ruleIds: [FENCE_RULE], reason: decision.reason, actor });
      decisions.push(decision);
    }
    return decisions;
  }

  return { channel: "EMAIL", transport: "live", send, probe };
}
