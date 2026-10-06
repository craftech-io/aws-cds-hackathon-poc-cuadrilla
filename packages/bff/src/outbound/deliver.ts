// The last step of a send the policy allowed and the checks passed (docs/tool-catalog.md, target
// `messaging`): the `ALLOW` with every rule evaluated is audited first (a message without its `ALLOW`
// is a violation, FL-077), then the message is written `QUEUED`, then the transport of the recipient's
// route (End User Messaging Social, or the simulated transport for every synthetic identity) sends it
// and records `SENT` with the payload as it left. An email goes through the single SES client, which
// fences the address again, takes the world's email cap and writes the outbox. A failed send is
// `UNAVAILABLE` (or the channel's code) and the message `FAILED`; nothing is retried here.
import type { Guardrail } from "@cuadrilla/shared";
import { toSendToolFailure } from "../channels/adapter";
import { type WhatsAppSendResult, sendFailureOf } from "../channels/whatsapp/transport";
import { localDateOf } from "../services/business-hours/zoned-time";
import type { PolicyDecision } from "../policy/engine";
import { toMessagePolicy } from "../policy/result";
import type { EmailContext, WhatsAppContext } from "./context";
import type { OutboundDeps } from "./deps";
import { appendOutMessage, auditPolicyDecision, auditRefusal } from "./persist";
import { displayTextOf, renderWhatsApp } from "./render/whatsapp";
import { CONTENT_KEY_REF } from "./repeat";
import { OUTBOUND_REASON, type EmailSendOutbound, type OutboundCall, type OutboundRefused, type OutboundResult, type WhatsAppSendRequest } from "./types";

export interface DeliverWhatsApp {
  readonly request: WhatsAppSendRequest;
  readonly context: WhatsAppContext;
  readonly decision: PolicyDecision;
  readonly messageId: string;
  readonly guardrail?: Guardrail;
  /** Content key of the request as it was asked (before G3), what the repeat guard compares. */
  readonly contentKey: string;
}

const MEDIA_MIME = { DOCUMENT: "application/pdf", IMAGE: "image/jpeg" } as const;

function mediaOf(request: WhatsAppSendRequest) {
  if (request.document !== undefined) return { kind: "DOCUMENT" as const, s3Key: request.document.media.key, mime: MEDIA_MIME.DOCUMENT, ...(request.attachmentSha256 === undefined ? {} : { sha256: request.attachmentSha256 }) };
  if (request.image !== undefined) return { kind: "IMAGE" as const, s3Key: request.image.media.key, mime: MEDIA_MIME.IMAGE };
  if (request.template?.document !== undefined) return { kind: "DOCUMENT" as const, s3Key: request.template.document.media.key, mime: MEDIA_MIME.DOCUMENT, ...(request.attachmentSha256 === undefined ? {} : { sha256: request.attachmentSha256 }) };
  return undefined;
}

export async function deliverWhatsApp(deps: OutboundDeps, call: OutboundCall, input: DeliverWhatsApp): Promise<OutboundResult> {
  const { context, decision, messageId, guardrail } = input;
  const { request } = input;
  const { person } = context;
  const rendered = await renderWhatsApp(
    request,
    { to: person.phone ?? "", personId: person.personId, phoneHash: person.phoneHash ?? "", clockId: context.clockId, messageId, day: localDateOf(new Date(context.at.sim), context.settings.timezone) },
    deps.nonces,
  );
  const decisionId = await auditPolicyDecision(deps, call, request, context, decision, { messageId });
  const media = mediaOf(request);
  const text = displayTextOf(request);
  const message = await appendOutMessage(deps, request, context, {
    messageId,
    status: "QUEUED",
    content: rendered.content,
    ...(text === undefined ? {} : { text }),
    ...(request.template === undefined ? {} : { templateParams: request.template.params }),
    ...(rendered.interactive === undefined ? {} : { interactive: rendered.interactive }),
    ...(media === undefined ? {} : { media }),
    policy: toMessagePolicy(decision, decisionId),
    extraRefs: { [CONTENT_KEY_REF]: input.contentKey, ...(request.reaction === undefined ? {} : { reactsTo: request.reaction.wamid }) },
  });
  const ref = { personId: message.personId, sentAtSim: message.sentAtSim, messageId };
  let sent: WhatsAppSendResult;
  try {
    sent = await deps.whatsapp(context.route).send({ message: ref, clockId: context.clockId, ispId: context.ispId, payload: rendered.payload, ...(rendered.media === undefined ? {} : { media: rendered.media }) });
  } catch (error) {
    sent = sendFailureOf(error);
  }
  const window = decision.evaluated.some((rule) => rule.ruleId === "CP-WA-24H" && rule.result === "PASS") ? ("OPEN" as const) : undefined;
  if (!sent.ok) {
    await deps.connector.conversations.updateMessage(ref, { status: "FAILED" });
    await auditRefusal(deps, call, request, context, { ruleIds: [], reason: `${OUTBOUND_REASON.SEND_FAILED}: ${sent.reason}`, messageId });
    call.log.error("outbound.send_failed", { messageId, code: sent.code, reason: sent.reason, transport: context.route.transport });
    return { status: "REFUSED", failure: toSendToolFailure(sent), ruleIds: [], messageId, decision, ...(guardrail === undefined ? {} : { guardrail }) } satisfies OutboundRefused;
  }
  call.log.info("outbound.sent", { messageId, kind: request.kind, transport: context.route.transport, source: context.route.source });
  return { status: "SENT", messageId, providerMessageId: sent.providerMessageId, decision, ...(guardrail === undefined ? {} : { guardrail }), ...(window === undefined ? {} : { window }) };
}

export interface DeliverEmail {
  readonly request: EmailSendOutbound;
  readonly context: EmailContext;
  readonly decision: PolicyDecision;
  readonly messageId: string;
  readonly guardrail?: Guardrail;
}

export async function deliverEmail(deps: OutboundDeps, call: OutboundCall, input: DeliverEmail): Promise<OutboundResult> {
  const { request, context, decision, messageId, guardrail } = input;
  await auditPolicyDecision(deps, call, request, context, decision, { messageId, refs: { mailId: messageId } });
  const sent = await deps.email.send({
    clockId: context.clockId,
    kind: request.kind,
    toRole: request.toRole,
    to: context.to ?? "",
    subject: request.subject,
    bodyText: request.text,
    workOrderId: request.workOrderId,
    ...(request.caseId === undefined ? {} : { caseId: request.caseId }),
    ...(request.attachment === undefined ? {} : { attachment: { ...request.attachment } }),
    sentAtSim: context.at.sim,
    mailId: messageId,
    actor: call.actor,
  });
  if (!sent.ok) {
    call.log.warn("outbound.email_refused", { mailId: messageId, code: sent.code, reason: sent.reason });
    return { status: "REFUSED", failure: toSendToolFailure(sent), ruleIds: sent.code === "RECIPIENT_NOT_ALLOWED" ? ["CP-RECIPIENT-FENCE"] : [], messageId, decision };
  }
  call.log.info("outbound.sent", { messageId, kind: request.kind, channel: "EMAIL", duplicate: sent.duplicate });
  return { status: "SENT", messageId: sent.mailId, providerMessageId: sent.providerMessageId, decision, ...(guardrail === undefined ? {} : { guardrail }) };
}
