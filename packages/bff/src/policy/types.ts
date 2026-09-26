// Input of the contact policy (docs/design-brief.md §5.7, ADR-0012): the message about to leave, its
// recipient and the facts the fifteen `CP-*` rules read, all taken at one instant on the two clocks
// (the world's simulated time and real time). The policy is a pure function of this input: it reads
// no clock and no table, so `PolicyAudit` re-evaluating a sent message with the records of that
// instant gets the decision the pipeline got (context.ts builds the input at any instant).
import { z } from "zod";
import {
  CaseId,
  CaseStatus,
  ClockId,
  IsoInstant,
  ManualSectionId,
  MessageKind,
  PersonId,
  SendChannel,
  SupervisorId,
  TemplateName,
  TemplateStatus,
  WorkOrderId,
  WorkOrderStatus,
} from "@cuadrilla/shared";
import type { CopyPack } from "../copy/types";
import { Sha256Hex, TimeOfDay } from "../domain/common";
import { StaffRole } from "../domain/people";
import { TemplateReviewStatus } from "../domain/reference";
import { MEXICO_CITY_TIME_ZONE, TimeZone } from "../services/business-hours/zoned-time";

// ---- The message -------------------------------------------------------------------------------

/** Shape of what goes out: the Meta payload type of a WhatsApp message, or an email. */
export const MessageForm = z.enum(["TEXT", "INTERACTIVE", "TEMPLATE", "DOCUMENT", "IMAGE", "REACTION", "READ_ACK", "EMAIL"]);
export type MessageForm = z.infer<typeof MessageForm>;

/** Who wrote the content: the agent (`send_whatsapp`), deterministic code, or a person on the bridge. */
export const AuthorKind = z.enum(["AGENT", "SYSTEM", "PERSON"]);
export type AuthorKind = z.infer<typeof AuthorKind>;

/** Copy key of a `SYSTEM_NOTICE` (copy/types.ts `CopyPack`): its text has one source in copy/. */
export const NoticeKey = z.string().regex(/^[a-z][A-Za-z]{1,63}$/, "expected a copy key such as optInRequired");
export type NoticeKey = z.infer<typeof NoticeKey>;

type CopyKey = keyof CopyPack & string;

/** A person of the allow list without opt-in gets only the invitation to send ALTA and its welcome. */
export const OPT_IN_EXEMPT_NOTICES: readonly CopyKey[] = ["optInRequired", "welcome"];
/** A person who sent BAJA gets only its confirmation. */
export const OPT_OUT_EXEMPT_NOTICES: readonly CopyKey[] = ["optOutConfirmed"];
/**
 * What a number outside the allow list may receive: the "internal use only" notice (FL-004) and, on
 * the live transport, the answers to an "ALTA <code>" that bound nothing (FL-101).
 */
export const UNKNOWN_NUMBER_NOTICES: readonly CopyKey[] = ["unknownNumber", "joinCodeInvalid", "leaseInUse"];

export const PolicyMessage = z
  .object({
    kind: MessageKind,
    channel: SendChannel,
    form: MessageForm,
    author: AuthorKind,
    /** With form `TEMPLATE` (and `CERTIFICATE`'s template), the template it renders. */
    templateName: TemplateName.optional(),
    /** With kind `SYSTEM_NOTICE`, the copy key of its fixed text. */
    notice: NoticeKey.optional(),
    /** The text as it would leave (free text, rendered template body, email body): rules 13 and 14. */
    text: z.string().max(20_000).optional(),
    /** `refs.citations` of an agent reply: manual sections it says it is grounded on. */
    citations: z.array(ManualSectionId).max(20).default([]),
    /** The outbound verification found policy or procedure statements in the text (`CP-CITATION`). */
    claimsPolicy: z.boolean().default(false),
    /** Answers an inbound message of the recipient (quiet hours exempt it): a reply, a button's effect. */
    inResponseToInbound: z.boolean().default(false),
    caseId: CaseId.optional(),
    workOrderId: WorkOrderId.optional(),
    /** SHA-256 of the attached certificate PDF (document, template header or email attachment). */
    attachmentSha256: Sha256Hex.optional(),
  })
  .strict();
export type PolicyMessage = z.output<typeof PolicyMessage>;

// ---- The recipient -----------------------------------------------------------------------------

/**
 * How a WhatsApp recipient is reached (ADR-0002); it fixes the clock of the time rules:
 *   SIMULATED    a synthetic identity of any world: simulated transport, the world's clock
 *   LIVE_WORLD   a real phone of the live world (`SeedOverrides.personPhones`): EUM Social, real clock
 *   PHONE_LEASE  a real phone bound by code to a judge world (`PHONELEASE#`): EUM Social, real clock
 *                and no quiet hours (`NOT_APPLICABLE_LEASE`: the judge is talking to it right then)
 */
export const WhatsAppRoute = z.enum(["SIMULATED", "LIVE_WORLD", "PHONE_LEASE"]);
export type WhatsAppRoute = z.infer<typeof WhatsAppRoute>;

/** The opt-in of a person at the instant: never given, in force, or revoked by BAJA. */
export const ConsentState = z.enum(["NONE", "GRANTED", "REVOKED"]);
export type ConsentState = z.infer<typeof ConsentState>;

export const PersonRecipient = z
  .object({
    kind: z.literal("PERSON"),
    personId: PersonId,
    role: StaffRole,
    /** On the allow list (`People.active`). */
    active: z.boolean(),
    /** A registered phone (the allow list is a list of phones). */
    hasPhone: z.boolean(),
    consent: ConsentState,
    route: WhatsAppRoute,
    /** Last inbound of the person on the world clock: the window of a synthetic identity. */
    lastInboundAtSim: IsoInstant.optional(),
    /** Meta's `timestamp` of the last live inbound (person of the live world, or the lease). */
    lastInboundAtReal: IsoInstant.optional(),
  })
  .strict();
export type PersonRecipient = z.output<typeof PersonRecipient>;

/** A number outside the allow list that wrote to us; the caller counts the replies (`UNKNOWN#GLOBAL#…`). */
export const UnknownNumberRecipient = z
  .object({
    kind: z.literal("UNKNOWN_NUMBER"),
    route: WhatsAppRoute.exclude(["PHONE_LEASE"]),
    /** Replies already sent to this number on this day (simulated day in a simulated world, real day live). */
    repliesToday: z.int().min(0),
    /** Replies already sent to unknown numbers by the live number this real day. */
    globalRepliesToday: z.int().min(0).default(0),
  })
  .strict();
export type UnknownNumberRecipient = z.output<typeof UnknownNumberRecipient>;

export const EmailRole = z.enum(["CUSTOMER", "OPS_MAILBOX", "ZONE_CHIEF"]);
export type EmailRole = z.infer<typeof EmailRole>;

/** Verdict of the world's recipient fence (outbound/recipient-fence.ts) on the address. */
export const FenceVerdict = z.object({ allowed: z.boolean(), reason: z.string().max(64).optional() }).strict();
export type FenceVerdict = z.infer<typeof FenceVerdict>;

export const EmailRecipient = z
  .object({
    kind: z.literal("EMAIL"),
    role: EmailRole,
    fence: FenceVerdict,
    /** What the world's daily email cap still allows, when the caller knows it. */
    emailsLeftToday: z.int().min(0).optional(),
  })
  .strict();
export type EmailRecipient = z.output<typeof EmailRecipient>;

export const PolicyRecipient = z.discriminatedUnion("kind", [PersonRecipient, UnknownNumberRecipient, EmailRecipient]);
export type PolicyRecipient = z.output<typeof PolicyRecipient>;

// ---- The facts ---------------------------------------------------------------------------------

/** The instant of an evaluation on both clocks. */
export const PolicyInstant = z.object({ sim: IsoInstant, real: IsoInstant }).strict();
export type PolicyInstant = z.infer<typeof PolicyInstant>;

export const PolicyWorld = z
  .object({
    clockId: ClockId,
    timezone: TimeZone.default(MEXICO_CITY_TIME_ZONE),
    quietHours: z.object({ start: TimeOfDay, end: TimeOfDay }).strict(),
    /** Simulated state of each template in this world; a template the world does not list is APPROVED. */
    templateStatus: z.partialRecord(TemplateName, TemplateStatus).default({}),
  })
  .strict();
export type PolicyWorld = z.output<typeof PolicyWorld>;

/**
 * The supervisors a case message may go to: the roster the case copied when it was opened (the shift
 * roster in force then), or the crew's roster of the day for a message without a case.
 */
export const RosterFacts = z.object({ primaryId: SupervisorId.optional(), secondaryId: SupervisorId.optional() }).strict();
export type RosterFacts = z.infer<typeof RosterFacts>;

export const PolicyFacts = z
  .object({
    now: PolicyInstant,
    world: PolicyWorld,
    /** Meta's review state of each template (`Reference`), for recipients on the live transport. */
    metaTemplateStatus: z.partialRecord(TemplateName, TemplateReviewStatus).default({}),
    /** The order of the message has a case `TAKEN`: the bridge speaks, not the agent. */
    bridgeActive: z.boolean().default(false),
    /** The case the message belongs to, with its status at the instant. */
    caseState: z.object({ caseId: CaseId, status: CaseStatus }).strict().optional(),
    roster: RosterFacts.optional(),
    /** `sentAtSim` of the other `DAY_START` messages already sent to the recipient. */
    dayStartsSentAtSim: z.array(IsoInstant).default([]),
    /** Sections `search_procedures` returned in the turn of an agent reply; absent when unknown. */
    turnSections: z.array(ManualSectionId).optional(),
    /** The order and the stored certificate of a `CERTIFICATE*` message. */
    certificate: z.object({ workOrderStatus: WorkOrderStatus, sha256: Sha256Hex.optional() }).strict().optional(),
  })
  .strict();
export type PolicyFacts = z.output<typeof PolicyFacts>;

export const PolicyInput = z.object({ message: PolicyMessage, recipient: PolicyRecipient, facts: PolicyFacts }).strict();
/** What a rule reads (defaults applied). */
export type PolicyInput = z.output<typeof PolicyInput>;
/** What a caller passes to `evaluate` (defaulted fields optional). */
export type PolicyInputShape = z.input<typeof PolicyInput>;
