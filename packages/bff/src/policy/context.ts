// Builds the policy input from the stored records at one instant: now (the outbound pipeline, the
// ladder, the day plan) or the past instant a message left (`PolicyAudit`, the seed invariants). The
// same function serves both, so a re-evaluation reads the records exactly as the send did: history
// entries after the instant are undone (history.ts), and inbound messages and day starts after it do
// not count. The caller says how the recipient is reached (its route, which fixes the clocks) and,
// for email, the fence verdict and the cap; everything else comes from the records.
import type { z } from "zod";
import type { Case } from "../domain/cases";
import type { IspSettings, ShiftRoster } from "../domain/isps";
import type { Consent, Person } from "../domain/people";
import type { Template } from "../domain/reference";
import type { PhoneLease } from "../domain/runtime-world";
import type { Certificate, WorkOrder } from "../domain/work-orders";
import { activeAt, caseStatusAt, consentAt, latestBy, rosterIdsAt, templateStatusAt, workOrderStatusAt } from "./history";
import { CERTIFICATE_KINDS } from "./kinds";
import type { EmailRecipient, PersonRecipient, PolicyFacts, PolicyInputShape, PolicyInstant, PolicyMessage, RosterFacts, UnknownNumberRecipient, WhatsAppRoute } from "./types";

/** An inbound message of the recipient: `live` when it came from Meta (a real phone). */
export interface InboundMark {
  readonly atSim: string;
  readonly atReal?: string;
  readonly live: boolean;
}

/** A `DAY_START` already sent to the recipient. */
export interface SentDayStart {
  readonly messageId: string;
  readonly sentAtSim: string;
  readonly sentAtReal?: string;
}

/** What the rules read, as the connector returns it (records.ts loads it). */
export interface PolicyRecords {
  /** Settings of the recipient's world: zone, quiet hours, simulated template state. */
  readonly settings: IspSettings;
  /** Meta's review state of the templates, for recipients on the live transport. */
  readonly metaTemplates?: ReadonlyArray<Pick<Template, "name" | "status">>;
  readonly person?: Person;
  readonly consent?: Consent;
  /** The recipient's `PHONELEASE#`, when it is a real phone bound by code. */
  readonly lease?: PhoneLease;
  readonly inbound?: readonly InboundMark[];
  readonly dayStarts?: readonly SentDayStart[];
  /** The order of the message and its cases. */
  readonly workOrder?: WorkOrder;
  readonly cases?: readonly Case[];
  /** The roster of the crew for the simulated day of the instant. */
  readonly shiftRoster?: ShiftRoster;
  readonly certificate?: Certificate;
  /** Sections `search_procedures` returned in the turn of an agent reply. */
  readonly turnSections?: readonly string[];
}

/** How the recipient is reached; a person comes from `records.person`. */
export type PolicyTarget =
  | { readonly kind: "PERSON"; readonly route: WhatsAppRoute }
  | z.input<typeof UnknownNumberRecipient>
  | z.input<typeof EmailRecipient>;

export interface BuildOptions {
  /** The message being re-evaluated: it never counts as a day start already sent. */
  readonly excludeMessageId?: string;
}

function notAfter(at: PolicyInstant) {
  const simMs = Date.parse(at.sim);
  const realMs = Date.parse(at.real);
  return (sim: string, real: string | undefined): boolean => Date.parse(sim) <= simMs && (real === undefined || Date.parse(real) <= realMs);
}

function personRecipient(route: WhatsAppRoute, records: PolicyRecords, at: PolicyInstant): z.input<typeof PersonRecipient> {
  const person = records.person;
  if (person === undefined) throw new RangeError("a message to a person needs the person's record");
  const counts = notAfter(at);
  const inbound = (records.inbound ?? []).filter((mark) => counts(mark.atSim, mark.atReal));
  const lastInboundAtSim = latestBy([person.lastInboundAtSim, ...inbound.map((mark) => mark.atSim)], at.sim);
  // A real phone's window starts at Meta's timestamp of its last live inbound: the lease's for a
  // phone bound by code, the person's in the live world.
  const storedReal = route === "PHONE_LEASE" ? records.lease?.lastInboundAtReal : person.lastInboundAtReal;
  const lastInboundAtReal = latestBy([storedReal, ...inbound.filter((mark) => mark.live).map((mark) => mark.atReal)], at.real);
  return {
    kind: "PERSON",
    personId: person.personId,
    role: person.role,
    active: activeAt(person, at),
    hasPhone: person.phoneHash !== undefined || person.phone !== undefined,
    consent: consentAt(records.consent, at),
    route,
    ...(lastInboundAtSim === undefined ? {} : { lastInboundAtSim }),
    ...(lastInboundAtReal === undefined ? {} : { lastInboundAtReal }),
  };
}

function rosterFacts(caseItem: Case | undefined, records: PolicyRecords, at: PolicyInstant): RosterFacts | undefined {
  // A case keeps the roster it was opened with (FL-007); other messages read the crew's roster.
  const roster = records.shiftRoster;
  const ids = caseItem !== undefined ? caseItem.roster : roster === undefined ? undefined : rosterIdsAt(roster, at);
  if (ids === undefined) return undefined;
  return { ...(ids.primaryId === undefined ? {} : { primaryId: ids.primaryId }), ...(ids.secondaryId === undefined ? {} : { secondaryId: ids.secondaryId }) };
}

function factsAt(message: z.input<typeof PolicyMessage>, records: PolicyRecords, at: PolicyInstant, options: BuildOptions): z.input<typeof PolicyFacts> {
  const { settings } = records;
  const counts = notAfter(at);
  const cases = (records.cases ?? []).flatMap((caseItem) => {
    const status = caseStatusAt(caseItem, at);
    return status === undefined ? [] : [{ caseItem, status }];
  });
  const ofMessage = cases.find(({ caseItem }) => caseItem.caseId === message.caseId);
  const roster = rosterFacts(ofMessage?.caseItem, records, at);
  const workOrder = records.workOrder;
  const dayStarts = (records.dayStarts ?? []).filter((sent) => sent.messageId !== options.excludeMessageId && counts(sent.sentAtSim, sent.sentAtReal));
  return {
    now: at,
    world: { clockId: settings.clockId, timezone: settings.timezone, quietHours: settings.quietHours, templateStatus: templateStatusAt(settings, at) },
    metaTemplateStatus: Object.fromEntries((records.metaTemplates ?? []).map((template) => [template.name, template.status])),
    bridgeActive: message.workOrderId !== undefined && cases.some(({ caseItem, status }) => status === "TAKEN" && caseItem.workOrderId === message.workOrderId),
    ...(ofMessage === undefined ? {} : { caseState: { caseId: ofMessage.caseItem.caseId, status: ofMessage.status } }),
    ...(roster === undefined ? {} : { roster }),
    dayStartsSentAtSim: dayStarts.map((sent) => sent.sentAtSim),
    ...(records.turnSections === undefined ? {} : { turnSections: [...records.turnSections] }),
    ...(CERTIFICATE_KINDS.has(message.kind) && workOrder !== undefined
      ? { certificate: { workOrderStatus: workOrderStatusAt(workOrder, at), ...(records.certificate?.sha256 === undefined ? {} : { sha256: records.certificate.sha256 }) } }
      : {}),
  };
}

/** The policy input of `message` to `target` at `at`, from the records. */
export function policyInputAt(
  message: z.input<typeof PolicyMessage>,
  target: PolicyTarget,
  records: PolicyRecords,
  at: PolicyInstant,
  options: BuildOptions = {},
): PolicyInputShape {
  const recipient = target.kind === "PERSON" ? personRecipient(target.route, records, at) : target;
  return { message, recipient, facts: factsAt(message, records, at, options) };
}
