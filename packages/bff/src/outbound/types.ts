// Contract of the outbound pipeline (docs/tool-catalog.md, target `messaging`; docs/design-brief.md
// §5.5-§5.7): the one path every message that leaves Cuadrilla takes, whoever asks for it: the agent's
// `send_whatsapp`, the validator's reaction, the worker (fixed notices, deferred sends, the ladder,
// the bridge, the certificate) and the cases target. The caller says what to say and to whom by
// person (or, for an email, by role of the order); the pipeline resolves the address from the records
// (`LAM-RECIPIENT`), never from the caller. Requests are zod schemas: they cross the queue and the
// `TIMER#DEFERRED_SEND` payload, an edge like any other.
import { z } from "zod";
import {
  CaseId,
  type Guardrail,
  IsoInstant,
  ManualSectionId,
  MessageKind,
  PersonId,
  PhotoItem,
  type RuleId,
  TemplateName,
  type ToolFailure,
  TurnTrigger,
  WaButtonAction,
  WorkOrderId,
  ZoneChiefId,
} from "@cuadrilla/shared";
import { EmailRecipientRole } from "../channels/email/request";
import type { AuditRefs } from "../domain/audit";
import { Actor, JsonObject, S3Key, Sha256Hex } from "../domain/common";
import { EmailKind } from "../domain/conversations";
import { NonceObject } from "../domain/runtime";
import type { Logger } from "../lib/log";
import type { PolicyDecision } from "../policy/engine";
import { NoticeKey } from "../policy/types";

export const MessageIdSchema = z.string().regex(/^[A-Za-z0-9_.:=+/-]{1,200}$/, "expected a message id");
const TurnIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** A button the pipeline turns into a nonce bound to the recipient's phone, the object and the action. */
export const OutboundButton = z.strictObject({ action: WaButtonAction, item: PhotoItem.optional(), object: NonceObject.optional() });
export type OutboundButton = z.infer<typeof OutboundButton>;

/** A row of a list: a nonce the caller already issued, or the action and object to issue one for. */
export const OutboundListRow = z
  .strictObject({
    title: z.string().min(1).max(24),
    description: z.string().min(1).max(72).optional(),
    id: z.string().min(1).max(128).optional(),
    action: WaButtonAction.optional(),
    object: NonceObject.optional(),
  })
  .refine((row) => (row.id === undefined) === (row.action !== undefined && row.object !== undefined), { message: "a row carries its nonce, or an action and an object" });
export type OutboundListRow = z.infer<typeof OutboundListRow>;

/** An object of our buckets a message attaches (the certificate PDF, a photo of a case). */
export const OutboundMediaRef = z.strictObject({ bucket: z.enum(["Evidence", "Media"]), key: S3Key });
export type OutboundMediaRef = z.infer<typeof OutboundMediaRef>;

const FileName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);

const Base = {
  kind: MessageKind,
  /** `AGENT`, `SYSTEM` or `PERSON:<id>` (a person on the bridge): `Message.author` and the policy's author. */
  author: Actor,
  /** Who wrote the words; by default the author's (`AGENT` → MODEL). A summary the agent wrote is MODEL. */
  textSource: z.enum(["MODEL", "CODE", "PERSON"]).optional(),
  /** Simulated instant the send is decided at: the event of the turn, or the world's now (ADR-0010). */
  eventAtSim: IsoInstant,
  trigger: TurnTrigger.optional(),
  /** The turn whose tool results ground MODEL text (`Runtime/TURN#<turnId>`); also the repeat guard's turn. */
  turnId: TurnIdSchema.optional(),
  workOrderId: WorkOrderId.optional(),
  caseId: CaseId.optional(),
  /** Extra references kept on the message (ids only). */
  refs: JsonObject.optional(),
  /** A derived id: a redelivered event never sends twice. */
  messageId: MessageIdSchema.optional(),
};

export const WhatsAppSendRequest = z
  .strictObject({
    ...Base,
    channel: z.literal("WHATSAPP"),
    personId: PersonId,
    /** The message answers an inbound of the recipient (quiet hours exempt it). */
    inResponseToInbound: z.boolean().default(false),
    /** `wamid` of the inbound it answers (reply context). */
    replyToWamid: z.string().min(1).max(256).optional(),
    /** The installer's text a `REPLY` answers (masked), for G2's relevance query. */
    question: z.string().max(4000).optional(),
    notice: NoticeKey.optional(),
    text: z.string().min(1).max(4096).optional(),
    buttons: z.array(OutboundButton).min(1).max(3).optional(),
    list: z.strictObject({ button: z.string().min(1).max(20), rows: z.array(OutboundListRow).min(1).max(10) }).optional(),
    template: z
      .strictObject({
        name: TemplateName,
        params: z.array(z.string()).max(10),
        /** Objects of the template's quick-reply buttons, in order (defaults by action). */
        buttonObjects: z.array(NonceObject).max(3).optional(),
        document: z.strictObject({ media: OutboundMediaRef, filename: FileName }).optional(),
      })
      .optional(),
    document: z.strictObject({ media: OutboundMediaRef, filename: FileName, caption: z.string().min(1).max(1024).optional() }).optional(),
    image: z.strictObject({ media: OutboundMediaRef, caption: z.string().min(1).max(1024).optional() }).optional(),
    reaction: z.strictObject({ wamid: z.string().min(1).max(256), emoji: z.string().min(1).max(8) }).optional(),
    /** SHA-256 of the attached certificate (`CP-CERT-EVIDENCE`). */
    attachmentSha256: Sha256Hex.optional(),
    /** Sections the text says it is grounded on (`refs.citations` of `send_whatsapp`). */
    citations: z.array(ManualSectionId).max(20).default([]),
  })
  .superRefine((request, ctx) => {
    const forms = [request.template, request.document, request.image, request.reaction, request.text].filter((part) => part !== undefined).length;
    if (request.template === undefined && request.document === undefined && request.image === undefined && request.reaction === undefined && request.text === undefined) {
      ctx.addIssue({ code: "custom", message: "a message carries a text, a template, a document, an image or a reaction" });
    } else if (forms > 1) {
      ctx.addIssue({ code: "custom", message: "one form per message" });
    }
    if ((request.buttons !== undefined || request.list !== undefined) && request.text === undefined) ctx.addIssue({ code: "custom", path: ["buttons"], message: "buttons and lists go with a text" });
    if (request.buttons !== undefined && request.list !== undefined) ctx.addIssue({ code: "custom", path: ["list"], message: "buttons or a list, not both" });
  });
export type WhatsAppSendRequest = z.output<typeof WhatsAppSendRequest>;
export type WhatsAppSendInput = z.input<typeof WhatsAppSendRequest>;

export const EmailSendOutbound = z.strictObject({
  ...Base,
  channel: z.literal("EMAIL"),
  kind: EmailKind,
  toRole: EmailRecipientRole,
  workOrderId: WorkOrderId,
  /** The zone chief of a `ZONE_CHIEF_ALERT` (the case's roster); the address comes from the person. */
  zoneChiefId: ZoneChiefId.optional(),
  subject: z.string().min(1).max(400),
  text: z.string().min(1).max(20_000),
  attachment: z.strictObject({ s3Key: S3Key, fileName: z.string().regex(/^acta-\d{5}\.pdf$/), sha256: Sha256Hex }).optional(),
});
export type EmailSendOutbound = z.output<typeof EmailSendOutbound>;
export type EmailSendInput = z.input<typeof EmailSendOutbound>;

export const OutboundRequest = z.union([WhatsAppSendRequest, EmailSendOutbound]);
export type OutboundRequest = WhatsAppSendRequest | EmailSendOutbound;
export type OutboundInput = WhatsAppSendInput | EmailSendInput;

/** What the agent is told about the 24 h window: open, or a template is required (nothing was sent). */
export type WindowState = "OPEN" | "TEMPLATE_REQUIRED";

/** Who asks and how the decision is recorded. */
export interface OutboundCall {
  /** `AuditLog.actor`: the agent for a session, the worker or the channel for code, a user for the console. */
  readonly actor: Actor;
  readonly correlationId: string;
  readonly log: Logger;
  /** References every decision of the call carries (turn, event). */
  readonly refs?: AuditRefs;
}

interface Decided {
  readonly messageId: string;
  /** Absent for a replay: a request whose message already exists is answered from it. */
  readonly decision?: PolicyDecision;
  readonly guardrail?: Guardrail;
  /** The message this request repeats (redelivered event, or the same send twice in one turn). */
  readonly replayOf?: string;
  readonly window?: WindowState;
}

export interface OutboundSent extends Decided {
  readonly status: "SENT";
  readonly providerMessageId?: string;
}

export interface OutboundDeferred extends Decided {
  readonly status: "DEFERRED";
  readonly nextAllowedAt: string;
  readonly timerKey: string;
}

export interface OutboundRefused {
  readonly status: "REFUSED";
  readonly failure: ToolFailure;
  readonly ruleIds: readonly RuleId[];
  readonly messageId?: string;
  readonly decision?: PolicyDecision;
  readonly guardrail?: Guardrail;
  readonly window?: WindowState;
}

export type OutboundResult = OutboundSent | OutboundDeferred | OutboundRefused;

/** `reason` of the refusals the pipeline answers itself (the policy's carry their rule). */
export const OUTBOUND_REASON = {
  GROUNDING_FAIL: "GROUNDING_FAIL",
  GUARDRAIL_UNAVAILABLE: "GUARDRAIL_UNAVAILABLE",
  G3_BLOCKED: "G3_BLOCKED",
  NO_RECIPIENT: "NO_RECIPIENT",
  CONTENT_INVALID: "CONTENT_INVALID",
  SEND_FAILED: "SEND_FAILED",
} as const;

/** Actions of the `AuditLog` rows the pipeline writes. */
export const OUTBOUND_ACTION = { WHATSAPP: "SEND_WHATSAPP", EMAIL: "SEND_EMAIL" } as const;
