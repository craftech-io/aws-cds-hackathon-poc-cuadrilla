// Loads the records the policy reads (context.ts `PolicyRecords`) through the `Connector` port, for
// one message at one instant: the world's settings, the recipient with its consent, its lease and its
// recent thread (inbound messages for the 24 h window, day starts already sent), the order with its
// cases, the crew's roster of the day, the certificate and the sections of the turn. Reads only; the
// evaluation itself stays pure. `PolicyAudit` calls it with the instant a message left.
import { z } from "zod";
import { ConnectorError, ManualSectionId } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import type { Message } from "../domain/conversations";
import { localDateOf } from "../services/business-hours/zoned-time";
import type { InboundMark, PolicyRecords, SentDayStart } from "./context";
import type { PolicyInstant, WhatsAppRoute } from "./types";

/** How far back the thread is read: the 24 h window and the local day of `DAY_START` both fit. */
export const THREAD_LOOKBACK_MS = 48 * 3_600_000;

const SENT_STATUSES: ReadonlySet<Message["status"]> = new Set<Message["status"]>(["SENT", "DELIVERED", "READ"]);

/** What `search_procedures` keeps in `Runtime/TURN#<turnId>`: the passages it returned. */
const SearchResult = z.object({ passages: z.array(z.object({ sectionId: ManualSectionId }).loose()).default([]) }).loose();

export interface PolicyLoadTarget {
  readonly ispId: string;
  /** The WhatsApp recipient, if the message goes to a person. */
  readonly personId?: string;
  readonly route?: WhatsAppRoute;
  readonly workOrderId?: string;
  /** Crew whose roster governs the message; defaults to the order's crew, then the person's. */
  readonly crewId?: string;
  /** The agent turn of a reply, for the sections it retrieved. */
  readonly turnId?: string;
  /** Load the order's certificate (`CERTIFICATE*` messages). */
  readonly certificate?: boolean;
  readonly at: PolicyInstant;
}

function threadOf(messages: readonly Message[]): { inbound: InboundMark[]; dayStarts: SentDayStart[] } {
  const inbound: InboundMark[] = [];
  const dayStarts: SentDayStart[] = [];
  for (const message of messages) {
    if (message.direction === "IN") {
      inbound.push({ atSim: message.sentAtSim, ...(message.sentAtReal === undefined ? {} : { atReal: message.sentAtReal }), live: !message.simulated });
    } else if (message.kind === "DAY_START" && SENT_STATUSES.has(message.status)) {
      dayStarts.push({ messageId: message.messageId, sentAtSim: message.sentAtSim, ...(message.sentAtReal === undefined ? {} : { sentAtReal: message.sentAtReal }) });
    }
  }
  return { inbound, dayStarts };
}

/** Sections of the turn; `undefined` when the turn has no search results (none made, or expired after 1 h). */
async function turnSectionsOf(connector: Connector, turnId: string): Promise<string[] | undefined> {
  const results = await connector.runtime.listTurnResults(turnId, "search_procedures");
  if (results.length === 0) return undefined;
  const sections = results.flatMap((result) => {
    const parsed = SearchResult.safeParse(result.output);
    return parsed.success ? parsed.data.passages.map((passage) => passage.sectionId) : [];
  });
  return [...new Set(sections)];
}

export async function loadPolicyRecords(connector: Connector, target: PolicyLoadTarget): Promise<PolicyRecords> {
  const settings = await connector.isps.getSettings(target.ispId);
  if (settings === undefined) throw new ConnectorError("NOT_FOUND", `settings of ${target.ispId}`, "Isps");
  const { personId, workOrderId, route } = target;
  const fromSim = new Date(Date.parse(target.at.sim) - THREAD_LOOKBACK_MS).toISOString();

  const [person, consent, messages, workOrder, cases, certificate, leases, metaTemplates, turnSections] = await Promise.all([
    personId === undefined ? undefined : connector.people.getPerson(personId),
    personId === undefined ? undefined : connector.people.getConsent(personId),
    personId === undefined ? [] : connector.conversations.listMessages(personId, { fromSim, toSim: target.at.sim }),
    workOrderId === undefined ? undefined : connector.workOrders.getWorkOrder(workOrderId),
    workOrderId === undefined ? [] : connector.cases.listCasesOfWorkOrder(workOrderId),
    workOrderId === undefined || target.certificate !== true ? undefined : connector.workOrders.getCertificate(workOrderId),
    route === "PHONE_LEASE" ? connector.worlds.listPhoneLeases(settings.clockId) : [],
    route === undefined || route === "SIMULATED" ? undefined : connector.reference.listTemplates(),
    target.turnId === undefined ? undefined : turnSectionsOf(connector, target.turnId),
  ]);

  const crewId = target.crewId ?? workOrder?.crewId ?? person?.crewId;
  const shiftRoster = crewId === undefined ? undefined : await connector.isps.getRoster(target.ispId, crewId, localDateOf(new Date(target.at.sim), settings.timezone));
  const lease = leases.find((candidate) => candidate.personId === personId);
  const { inbound, dayStarts } = threadOf(messages);

  return {
    settings,
    ...(metaTemplates === undefined ? {} : { metaTemplates }),
    ...(person === undefined ? {} : { person }),
    ...(consent === undefined ? {} : { consent }),
    ...(lease === undefined ? {} : { lease }),
    inbound,
    dayStarts,
    ...(workOrder === undefined ? {} : { workOrder }),
    cases,
    ...(shiftRoster === undefined ? {} : { shiftRoster }),
    ...(certificate === undefined ? {} : { certificate }),
    ...(turnSections === undefined ? {} : { turnSections }),
  };
}
