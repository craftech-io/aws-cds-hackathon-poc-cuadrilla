// Evaluation at a past instant, for `PolicyAudit` (docs/architecture.md §12, FL-077): a sent message
// is re-evaluated at the instant it left, with the records as they were then (context.ts), and a
// denial is a violation. What the stored message cannot say by itself (its form and author as the
// policy saw them, the notice key, the citations, whether it answered an inbound, the route and the
// sections of its turn, whose results expire after an hour) the outbound pipeline keeps in
// `Message.refs.policy` with `policyRefs` when it sends; a message without them is re-evaluated with
// what its own fields say, which is stricter (it does not answer an inbound, cites nothing).
import { z } from "zod";
import { ManualSectionId } from "@cuadrilla/shared";
import { Sha256Hex } from "../domain/common";
import type { Message, MessageContent, OutboundEmail } from "../domain/conversations";
import { type BuildOptions, type PolicyRecords, type PolicyTarget, policyInputAt } from "./context";
import { type PolicyDecision, evaluate } from "./engine";
import { AuthorKind, type FenceVerdict, MessageForm, NoticeKey, PolicyInput, type PolicyInputShape, type PolicyInstant, type PolicyMessage, WhatsAppRoute } from "./types";

/** Key of `Message.refs` that keeps what the policy saw of a message. */
export const POLICY_REFS_KEY = "policy";

export const PolicyRefs = z
  .object({
    form: MessageForm,
    author: AuthorKind,
    route: WhatsAppRoute.optional(),
    notice: NoticeKey.optional(),
    citations: z.array(ManualSectionId).optional(),
    claimsPolicy: z.boolean().optional(),
    inResponseToInbound: z.boolean().optional(),
    attachmentSha256: Sha256Hex.optional(),
    turnSections: z.array(ManualSectionId).optional(),
  })
  .strict();
export type PolicyRefs = z.infer<typeof PolicyRefs>;

/** What the pipeline stores in `Message.refs[POLICY_REFS_KEY]` for the input it evaluated. */
export function policyRefs(raw: PolicyInputShape): PolicyRefs {
  const { message, recipient, facts } = PolicyInput.parse(raw);
  return {
    form: message.form,
    author: message.author,
    ...(recipient.kind === "EMAIL" ? {} : { route: recipient.route }),
    ...(message.notice === undefined ? {} : { notice: message.notice }),
    ...(message.citations.length === 0 ? {} : { citations: message.citations }),
    ...(message.claimsPolicy ? { claimsPolicy: true } : {}),
    ...(message.inResponseToInbound ? { inResponseToInbound: true } : {}),
    ...(message.attachmentSha256 === undefined ? {} : { attachmentSha256: message.attachmentSha256 }),
    ...(facts.turnSections === undefined ? {} : { turnSections: facts.turnSections }),
  };
}

/** Evaluates `message` to `target` at `at` with the records (now or past). */
export function evaluateAt(message: z.input<typeof PolicyMessage>, target: PolicyTarget, records: PolicyRecords, at: PolicyInstant, options: BuildOptions = {}): PolicyDecision {
  return evaluate(policyInputAt(message, target, records, at, options));
}

const FORM_OF_CONTENT: Readonly<Partial<Record<MessageContent, MessageForm>>> = {
  TEXT: "TEXT",
  INTERACTIVE: "INTERACTIVE",
  TEMPLATE: "TEMPLATE",
  DOCUMENT: "DOCUMENT",
  IMAGE: "IMAGE",
  REACTION: "REACTION",
  READ_ACK: "READ_ACK",
};

function authorKindOf(author: Message["author"]): AuthorKind {
  return author === "AGENT" || author === "SYSTEM" ? author : "PERSON";
}

/** The instant a stored message left; a seeded message without real time uses its simulated one. */
function sentAt(sentAtSim: string, sentAtReal: string | undefined): PolicyInstant {
  return { sim: sentAtSim, real: sentAtReal ?? sentAtSim };
}

/** Re-evaluates an outbound WhatsApp message to a person at the instant it left. */
export function evaluateSentAsOf(sent: Message, records: PolicyRecords): PolicyDecision {
  if (sent.direction !== "OUT" || sent.kind === undefined) throw new RangeError("only an outbound message with its kind can be re-evaluated");
  const stored = PolicyRefs.safeParse(sent.refs?.[POLICY_REFS_KEY]);
  const refs: Partial<PolicyRefs> = stored.success ? stored.data : {};
  const message: z.input<typeof PolicyMessage> = {
    kind: sent.kind,
    channel: "WHATSAPP",
    form: refs.form ?? FORM_OF_CONTENT[sent.content] ?? "TEXT",
    author: refs.author ?? authorKindOf(sent.author),
    ...(sent.templateName === undefined ? {} : { templateName: sent.templateName }),
    ...(refs.notice === undefined ? {} : { notice: refs.notice }),
    ...(sent.text === undefined ? {} : { text: sent.text }),
    citations: refs.citations ?? [],
    claimsPolicy: refs.claimsPolicy ?? false,
    inResponseToInbound: refs.inResponseToInbound ?? false,
    ...(sent.caseId === undefined ? {} : { caseId: sent.caseId }),
    ...(sent.workOrderId === undefined ? {} : { workOrderId: sent.workOrderId }),
    ...(refs.attachmentSha256 !== undefined
      ? { attachmentSha256: refs.attachmentSha256 }
      : sent.media?.kind === "DOCUMENT" && sent.media.sha256 !== undefined
        ? { attachmentSha256: sent.media.sha256 }
        : {}),
  };
  const route = refs.route ?? (sent.transport === "live" ? (records.lease !== undefined ? "PHONE_LEASE" : "LIVE_WORLD") : "SIMULATED");
  // What the pipeline kept at the send wins: the turn's own results expire after an hour.
  const turnSections = refs.turnSections ?? records.turnSections;
  return evaluateAt(message, { kind: "PERSON", route }, { ...records, ...(turnSections === undefined ? {} : { turnSections }) }, sentAt(sent.sentAtSim, sent.sentAtReal), {
    excludeMessageId: sent.messageId,
  });
}

/** Re-evaluates an email of the outbox at the instant it left; the fence verdict is the caller's. */
export function evaluateMailAsOf(mail: OutboundEmail, fence: FenceVerdict, records: PolicyRecords): PolicyDecision {
  const message: z.input<typeof PolicyMessage> = {
    kind: mail.kind,
    channel: "EMAIL",
    form: "EMAIL",
    author: "SYSTEM",
    text: mail.bodyText,
    ...(mail.caseId === undefined ? {} : { caseId: mail.caseId }),
    ...(mail.workOrderId === undefined ? {} : { workOrderId: mail.workOrderId }),
    ...(mail.attachment?.sha256 === undefined ? {} : { attachmentSha256: mail.attachment.sha256 }),
  };
  return evaluateAt(message, { kind: "EMAIL", role: mail.toRole, fence }, records, sentAt(mail.sentAtSim, mail.sentAtReal), { excludeMessageId: mail.mailId });
}
