// Step 1 of the pipeline: everything a send is decided with, read from the records at one instant
// (the event's simulated instant and real now). The recipient comes from the registry, never from the
// caller (`LAM-RECIPIENT`): a WhatsApp goes to the phone `People` holds for the person, through the
// transport its route gets (channels/registry.ts, ADR-0002); an email goes to the address the order's
// customer, the operator's mailbox or the case's zone chief has, behind the world's fence. The policy
// records (policy/records.ts), the turn's tool results and the person's recent thread come along.
import { ToolError } from "@cuadrilla/shared";
import { type WhatsAppRoute, whatsAppRouteOf } from "../channels/registry";
import type { Message } from "../domain/conversations";
import type { IspSettings } from "../domain/isps";
import type { Person } from "../domain/people";
import type { TurnResult } from "../domain/runtime";
import type { WorkOrder } from "../domain/work-orders";
import type { PolicyRecords } from "../policy/context";
import { THREAD_LOOKBACK_MS, loadPolicyRecords } from "../policy/records";
import type { FenceVerdict, PolicyInstant, WhatsAppRoute as PolicyRoute } from "../policy/types";
import type { OutboundDeps } from "./deps";
import { fenceEmailRecipient } from "./recipient-fence";
import { OUTBOUND_REASON, type EmailSendOutbound, type WhatsAppSendRequest } from "./types";

const CERTIFICATE_KINDS = new Set(["CERTIFICATE", "CERTIFICATE_EMAIL"]);
const HISTORY_LIMIT = 100;

interface Common {
  readonly ispId: string;
  readonly clockId: string;
  readonly at: PolicyInstant;
  readonly records: PolicyRecords;
  /** Tool results of the turn, oldest first (empty without a turn or after their hour). */
  readonly results: readonly TurnResult[];
}

export interface WhatsAppContext extends Common {
  readonly channel: "WHATSAPP";
  readonly person: Person;
  readonly settings: IspSettings;
  /** The transport the registry picks for this person (ADR-0002). */
  readonly route: WhatsAppRoute;
  /** The same route as the policy's clocks read it. */
  readonly policyRoute: PolicyRoute;
  /** The person's recent thread, newest first (repeat guard, the question of a reply). */
  readonly history: readonly Message[];
}

export interface EmailContext extends Common {
  readonly channel: "EMAIL";
  readonly workOrder: WorkOrder;
  /** The registered address; `undefined` when the role has none. */
  readonly to?: string;
  readonly fence: FenceVerdict;
}

export type SendContext = WhatsAppContext | EmailContext;

function noRecipient(message: string): never {
  throw new ToolError("NOT_FOUND", message, OUTBOUND_REASON.NO_RECIPIENT);
}

/** The policy's name of a registry route (its clocks follow the transport, ADR-0002). */
export function policyRouteOf(route: WhatsAppRoute): PolicyRoute {
  if (route.source === "LIVE_WORLD") return "LIVE_WORLD";
  if (route.source === "PHONE_LEASE") return "PHONE_LEASE";
  return "SIMULATED";
}

async function resultsOf(deps: OutboundDeps, turnId: string | undefined): Promise<TurnResult[]> {
  return turnId === undefined ? [] : deps.connector.runtime.listTurnResults(turnId);
}

async function nowAt(deps: OutboundDeps, eventAtSim: string): Promise<PolicyInstant> {
  return { sim: new Date(Date.parse(eventAtSim)).toISOString(), real: (await deps.realClock.now()).toISOString() };
}

export async function loadWhatsAppContext(deps: OutboundDeps, request: WhatsAppSendRequest): Promise<WhatsAppContext> {
  const { connector } = deps;
  const person = await connector.people.getPerson(request.personId);
  if (person === undefined) return noRecipient("the recipient is not a registered person");
  const settings = await connector.isps.getSettings(person.ispId);
  if (settings === undefined || settings.clockId !== person.clockId) return noRecipient("the recipient's world has no settings");
  if (person.phone === undefined) return noRecipient("the recipient has no registered phone");
  const leases = await connector.worlds.listPhoneLeases(person.clockId);
  // Only a lease that kept its phone can be reached: the person's own phone is synthetic.
  const lease = leases.find((candidate) => candidate.personId === person.personId && candidate.phone !== undefined);
  const route = whatsAppRouteOf({ clockId: person.clockId, phone: person.phone, worldMode: settings.whatsappMode, lease, registeredRealPhones: deps.registeredRealPhones() });
  const recipient = route.source === "PHONE_LEASE" && lease?.phone !== undefined ? { ...person, phone: lease.phone, phoneHash: lease.phoneHash } : person;
  const policyRoute = policyRouteOf(route);
  const at = await nowAt(deps, request.eventAtSim);
  const fromSim = new Date(Date.parse(at.sim) - THREAD_LOOKBACK_MS).toISOString();
  const authorIsAgent = request.author === "AGENT";
  const [records, results, history] = await Promise.all([
    loadPolicyRecords(connector, {
      ispId: person.ispId,
      personId: person.personId,
      route: policyRoute,
      ...(request.workOrderId === undefined ? {} : { workOrderId: request.workOrderId }),
      ...(authorIsAgent && request.turnId !== undefined ? { turnId: request.turnId } : {}),
      certificate: CERTIFICATE_KINDS.has(request.kind),
      at,
    }),
    resultsOf(deps, request.turnId),
    connector.conversations.listMessages(person.personId, { fromSim, descending: true, limit: HISTORY_LIMIT }),
  ]);
  return { channel: "WHATSAPP", ispId: person.ispId, clockId: person.clockId, at, records, results, person: recipient, settings, route, policyRoute, history };
}

async function emailAddressOf(deps: OutboundDeps, request: EmailSendOutbound, workOrder: WorkOrder): Promise<string | undefined> {
  const { connector } = deps;
  switch (request.toRole) {
    case "CUSTOMER":
      return (await connector.people.getCustomer(workOrder.customerId))?.email;
    case "OPS_MAILBOX":
      return (await connector.isps.getIsp(workOrder.ispId))?.opsMailbox;
    case "ZONE_CHIEF": {
      const fromCase = request.caseId === undefined ? undefined : (await connector.cases.getCase(request.caseId))?.roster.zoneChiefId;
      const chiefId = request.zoneChiefId ?? fromCase;
      const chief = chiefId === undefined ? undefined : await connector.people.getPerson(chiefId);
      return chief?.clockId === workOrder.clockId ? chief.email : undefined;
    }
  }
}

export async function loadEmailContext(deps: OutboundDeps, request: EmailSendOutbound): Promise<EmailContext> {
  const workOrder = await deps.connector.workOrders.getWorkOrder(request.workOrderId);
  if (workOrder === undefined) return noRecipient("the work order of the email does not exist");
  const at = await nowAt(deps, request.eventAtSim);
  const to = await emailAddressOf(deps, request, workOrder);
  const decision = to === undefined ? undefined : fenceEmailRecipient(to, workOrder.clockId, { demoRecipients: deps.demoRecipients() });
  const fence: FenceVerdict = decision === undefined ? { allowed: false, reason: "NO_ADDRESS" } : decision.allowed ? { allowed: true, reason: decision.recipientClass } : { allowed: false, reason: decision.reason };
  const [records, results] = await Promise.all([
    loadPolicyRecords(deps.connector, { ispId: workOrder.ispId, workOrderId: workOrder.workOrderId, certificate: request.kind === "CERTIFICATE_EMAIL", at }),
    resultsOf(deps, request.turnId),
  ]);
  return { channel: "EMAIL", ispId: workOrder.ispId, clockId: workOrder.clockId, at, records, results, workOrder, ...(to === undefined ? {} : { to }), fence };
}

/** The installer's text a `REPLY` answers: the request's, the inbound it replies to, or the last inbound. */
export function questionOf(request: WhatsAppSendRequest, context: WhatsAppContext): string | undefined {
  if (request.question !== undefined) return request.question;
  const inbound = context.history.filter((message) => message.direction === "IN");
  const answered = request.replyToWamid === undefined ? undefined : inbound.find((message) => message.providerMessageId === request.replyToWamid || message.messageId === request.replyToWamid);
  const message = answered ?? inbound[0];
  return message?.text ?? message?.transcript?.text;
}
