// Test support for cases/, safety/ and the `cases` target (never imported by runtime code): the demo
// world of docs/seed-spec.md over the memory connector (operator `isp-demo`, crew Norte 3 with Adriana on
// duty and Héctor as backup, zone chief Marisol, installer Rogelio with orders 24817 and 24818 on
// 13/10), and fakes of the ports. The outbound fake runs the real contact policy (policy/engine.ts) on
// the stored records and stores what it decided in `Conversations` and `AuditLog`, so the ladder's
// plan B and skips are decided exactly as the pipeline will decide them.
import type { ContactRule } from "@cuadrilla/shared";
import { renderTemplateBody } from "../copy/templates";
import { CLOCK, ISP, installer, supervisor, testConnector, workOrder } from "../connector/testing";
import type { Message } from "../domain/conversations";
import type { Timer } from "../domain/timers";
import { createLogger } from "../lib/log";
import type { NetworkClient } from "../network/client";
import { evaluate } from "../policy/engine";
import { policyInputAt } from "../policy/context";
import { loadPolicyRecords } from "../policy/records";
import { toDecisionInput, toMessagePolicy } from "../policy/result";
import { ROSTER_N3, demoSettings, mx } from "../policy/testing";
import type { AuthorKind, MessageForm } from "../policy/types";
import type { TimerPort } from "../agent-tools/common/ports";
import type { CaseDeps, CaseOutbound, CaseSendOutcome, CaseTurnQueue, CaseWhatsAppSend, ZoneChiefAlertSend, CaseClosedTurn } from "./ports";

export { mx };

/** Real instant of the tests: the demo world is replayed weeks after its simulated day. */
export const CASES_REAL_NOW = "2026-11-02T18:00:00.000Z";
export const ORDER = "wo-24818";
export const HASH_ADRIANA = "e".repeat(64);
export const HASH_HECTOR = "f".repeat(64);

export type World = ReturnType<typeof testConnector>;

/** The demo world with the people, orders, zone, crew and roster the cases read. */
export async function caseWorld(options: { readonly clockMode?: "PAUSED" | "RUNNING" } = {}): Promise<World> {
  const world = testConnector(CASES_REAL_NOW);
  await seedCaseWorld(world, options);
  return world;
}

/** Seeds the demo world of the cases into an empty memory connector (also the tools' test kit). */
export async function seedCaseWorld(world: World, options: { readonly clockMode?: "PAUSED" | "RUNNING" } = {}): Promise<void> {
  const { isps, people, workOrders, runtime } = world.connector;
  const realNow = world.now().toISOString();
  await isps.putIsp({ ispId: ISP, kind: "DEMO", clockId: CLOCK });
  await isps.putSettings(demoSettings());
  await isps.putZone({ ispId: ISP, clockId: CLOCK, zoneId: "zone-norte", name: "Norte", opticalClass: "B+", acceptanceRange: { minDbm: -25, maxDbm: -8 }, zoneChiefId: "zc-marisol" });
  await isps.putCrew({ ispId: ISP, clockId: CLOCK, crewId: "crew-n3", zoneId: "zone-norte", name: "Norte 3" });
  await isps.setRoster(ROSTER_N3, { actor: "SEED" });
  await people.createPerson(installer());
  await people.createPerson(supervisor("sup-adriana", HASH_ADRIANA, { firstName: "Adriana", phone: "+525501020001" }));
  await people.createPerson(supervisor("sup-hector", HASH_HECTOR, { firstName: "Héctor", phone: "+525501020002" }));
  await people.createPerson(installer({ personId: "zc-marisol", role: "ZONE_CHIEF", firstName: "Marisol", lastName: "Cárdenas", phone: "+525501030001", phoneHash: "9".repeat(64), email: "success+zc-marisol@simulator.amazonses.com" }));
  for (const personId of ["inst-rogelio", "sup-adriana", "sup-hector"]) {
    await people.grantConsent({ personId, clockId: CLOCK, medium: "SEED", textVersion: "v001" }, { actor: "SEED", atSim: mx("2026-10-01 08:00") });
  }
  await workOrders.createWorkOrder(workOrder({ status: "IN_PROGRESS" }));
  await workOrders.createWorkOrder(workOrder({ workOrderId: ORDER, workOrderNumber: "24818", customerId: "cust-10422", status: "IN_PROGRESS", appointmentWindow: { startSim: mx("2026-10-13 11:30"), endSim: mx("2026-10-13 13:30") } }));
  const running = options.clockMode === "RUNNING";
  await runtime.createClock({
    clockId: CLOCK,
    ispId: ISP,
    kind: "DEMO",
    mode: running ? "RUNNING" : "PAUSED",
    offsetMs: running ? Date.parse(mx("2026-10-13 11:50")) - Date.parse(realNow) : 0,
    pausedSimNow: mx("2026-10-13 11:50"),
    worldEpoch: 1,
    ...(running ? { runningUntilReal: new Date(Date.parse(realNow) + 30 * 60_000).toISOString() } : {}),
  });
}

/** An inbound message of a person (it opens the person's 24 h window), stored as the channel stores it. */
export async function inbound(world: World, personId: string, atSim: string, fields: Partial<Message> = {}): Promise<Message> {
  await world.connector.people.recordInbound(personId, { atSim });
  return world.connector.conversations.appendMessage({
    messageId: `wamid.SIM.${personId}.${Date.parse(atSim)}`,
    personId,
    ispId: ISP,
    clockId: CLOCK,
    direction: "IN",
    channel: "WHATSAPP",
    content: "TEXT",
    status: "RECEIVED",
    author: `PERSON:${personId}`,
    simulated: true,
    sentAtSim: atSim,
    ...fields,
  });
}

export interface SentRecord {
  readonly request: CaseWhatsAppSend;
  readonly outcome: CaseSendOutcome;
}

export interface FakeOutbound extends CaseOutbound {
  readonly sent: SentRecord[];
  readonly emails: Array<{ readonly request: ZoneChiefAlertSend; readonly outcome: CaseSendOutcome }>;
  /** What actually went out (SENT or DEFERRED), as `kind:form:personId`. */
  delivered(): string[];
}

function authorKindOf(author: string): AuthorKind {
  return author === "AGENT" ? "AGENT" : author.startsWith("PERSON:") ? "PERSON" : "SYSTEM";
}

function textOf(request: CaseWhatsAppSend): string | undefined {
  if (request.form === "TEMPLATE") return renderTemplateBody(request.templateName, request.params);
  if (request.form === "IMAGE") return request.caption;
  return request.text;
}

const CONTENT: Readonly<Record<CaseWhatsAppSend["form"], Message["content"]>> = { TEXT: "TEXT", INTERACTIVE: "INTERACTIVE", TEMPLATE: "TEMPLATE", IMAGE: "IMAGE" };

function outcomeOf(stored: Message): CaseSendOutcome {
  if (stored.status === "DENIED") return { status: "DENIED", messageId: stored.messageId, ...(stored.policy?.ruleIds[0] === undefined ? {} : { deniedBy: stored.policy.ruleIds[0] as ContactRule }) };
  return stored.status === "DEFERRED" ? { status: "DEFERRED", messageId: stored.messageId } : { status: "SENT", messageId: stored.messageId };
}

/** The outbound pipeline as far as cases care: the real policy, the message stored, the decision audited. */
export function policyOutbound(world: World): FakeOutbound {
  const { connector } = world;
  const sent: SentRecord[] = [];
  const emails: FakeOutbound["emails"] = [];
  return {
    sent,
    emails,
    delivered: () => sent.filter((record) => record.outcome.status !== "DENIED").map(({ request }) => `${request.kind}:${request.form}:${request.personId}`),
    async sendWhatsApp(request) {
      const existing = await connector.conversations.findMessage(request.personId, request.messageId);
      if (existing !== undefined) return outcomeOf(existing);
      const at = { sim: request.atSim, real: world.now().toISOString() };
      const records = await loadPolicyRecords(connector, { ispId: request.ispId, personId: request.personId, route: "SIMULATED", ...(request.workOrderId === undefined ? {} : { workOrderId: request.workOrderId }), at });
      const text = textOf(request);
      const form: MessageForm = request.form;
      const message = {
        kind: request.kind,
        channel: "WHATSAPP" as const,
        form,
        author: authorKindOf(request.author),
        ...(request.form === "TEMPLATE" ? { templateName: request.templateName } : {}),
        ...(request.notice === undefined ? {} : { notice: request.notice }),
        ...(text === undefined ? {} : { text }),
        inResponseToInbound: request.inResponseToInbound ?? false,
        ...(request.caseId === undefined ? {} : { caseId: request.caseId }),
        ...(request.workOrderId === undefined ? {} : { workOrderId: request.workOrderId }),
      };
      const decision = evaluate(policyInputAt(message, { kind: "PERSON", route: "SIMULATED" }, records, at));
      await connector.audit.append(toDecisionInput(decision, { ispId: request.ispId, clockId: request.clockId, action: "SEND_WHATSAPP", actor: request.author, messageId: request.messageId, refs: { ...(request.caseId === undefined ? {} : { caseId: request.caseId }), ...(request.workOrderId === undefined ? {} : { workOrderId: request.workOrderId }) } }));
      const status = decision.outcome === "ALLOW" ? "SENT" : decision.outcome === "DEFER" ? "DEFERRED" : "DENIED";
      const stored = await connector.conversations.appendMessage({
        messageId: request.messageId,
        personId: request.personId,
        ispId: request.ispId,
        clockId: request.clockId,
        direction: "OUT",
        channel: "WHATSAPP",
        content: CONTENT[request.form],
        kind: request.kind,
        ...(request.workOrderId === undefined ? {} : { workOrderId: request.workOrderId }),
        ...(request.caseId === undefined ? {} : { caseId: request.caseId }),
        ...(text === undefined ? {} : { text }),
        ...(request.form === "TEMPLATE" ? { templateName: request.templateName, templateParams: [...request.params] } : {}),
        ...(request.form === "TEMPLATE" || request.form === "INTERACTIVE" ? { interactive: { buttons: request.buttons.map((button) => button.action) } } : {}),
        ...(request.form === "IMAGE" ? { media: { kind: "IMAGE", s3Key: request.media.s3Key, mime: request.media.mime } } : {}),
        status,
        policy: toMessagePolicy(decision),
        author: request.author,
        simulated: true,
        sentAtSim: request.atSim,
        ...(request.refs === undefined ? {} : { refs: request.refs }),
      });
      const outcome = outcomeOf(stored);
      sent.push({ request, outcome });
      return outcome;
    },
    async sendZoneChiefAlert(request) {
      const at = { sim: request.atSim, real: world.now().toISOString() };
      const records = await loadPolicyRecords(connector, { ispId: request.ispId, workOrderId: request.workOrderId, at });
      const message = { kind: "ZONE_CHIEF_ALERT" as const, channel: "EMAIL" as const, form: "EMAIL" as const, author: "SYSTEM" as const, text: request.summary, caseId: request.caseId, workOrderId: request.workOrderId };
      const decision = evaluate(policyInputAt(message, { kind: "EMAIL", role: "ZONE_CHIEF", fence: { allowed: true } }, records, at));
      await connector.audit.append(toDecisionInput(decision, { ispId: request.ispId, clockId: request.clockId, action: "SEND_EMAIL", actor: "SYSTEM", messageId: request.messageId, refs: { caseId: request.caseId, workOrderId: request.workOrderId } }));
      const outcome: CaseSendOutcome = decision.allowed ? { status: "SENT", messageId: request.messageId } : { status: "DENIED", messageId: request.messageId, ...(decision.deniedBy === undefined ? {} : { deniedBy: decision.deniedBy }) };
      emails.push({ request, outcome });
      return outcome;
    },
  };
}

/** `TimerPort` over the connector's timers: what the ladder arms and cancels, without a scheduler. */
export function memoryTimers(world: World): TimerPort & { readonly armed: Timer[] } {
  const { timers } = world.connector;
  const armed: Timer[] = [];
  return {
    armed,
    async arm(request) {
      const ref = { home: request.home, kind: request.kind, timerId: request.timerId };
      const existing = await timers.getTimer(ref);
      if (existing !== undefined) return existing;
      const timer = await timers.createTimer({ ...request, status: "SCHEDULED", payload: request.payload ?? {} });
      armed.push(timer);
      return timer;
    },
    async reschedule(ref, dueAtSim, options = {}) {
      const current = await timers.getTimer(ref);
      if (current === undefined) throw new Error("no such timer");
      return timers.rescheduleTimer(ref, dueAtSim, current.version, options);
    },
    async cancel(ref, reason) {
      const current = await timers.getTimer(ref);
      if (current === undefined || current.status !== "SCHEDULED") return current;
      return timers.setTimerStatus(ref, { status: "CANCELLED", reason }, current.version);
    },
    locate: async () => undefined,
    fire: async () => ({ status: "MISSING" }),
  };
}

export interface FakeNetwork {
  readonly actions: Array<{ readonly serial: string; readonly kind: string }>;
  readonly reads: Array<{ readonly serial: string; readonly caller: string }>;
  /** What the next reads answer. */
  answer: { readonly kind: "OK"; readonly operState: "ONLINE" | "LOS" | "NOT_PROVISIONED"; readonly rxPowerDbm?: number } | { readonly kind: "UNAVAILABLE" };
  getOnuStatus: CaseNetwork["getOnuStatus"];
  reportPhysicalAction: CaseNetwork["reportPhysicalAction"];
}

type CaseNetwork = Pick<NetworkClient, "getOnuStatus" | "reportPhysicalAction">;

export function fakeNetwork(): FakeNetwork {
  const network: FakeNetwork = {
    actions: [],
    reads: [],
    answer: { kind: "OK", operState: "ONLINE", rxPowerDbm: -21.4 },
    async getOnuStatus(call) {
      network.reads.push({ serial: call.serial, caller: call.caller });
      const answer = network.answer;
      if (answer.kind === "UNAVAILABLE") return { kind: "UNAVAILABLE", reason: "HTTP_5XX", attempts: 3 };
      return { kind: "OK", attempts: 1, value: { serial: call.serial, operState: answer.operState, observedAt: call.atSim, ...(answer.rxPowerDbm === undefined ? {} : { rxPowerDbm: answer.rxPowerDbm }) } };
    },
    async reportPhysicalAction(call) {
      network.actions.push({ serial: call.serial, kind: call.kind });
      return { kind: "OK", attempts: 1, value: { serial: call.serial, behaviour: "LOW_POWER_THEN_OK", fixed: true, changed: true } };
    },
  };
  return network;
}

export interface CaseKit {
  readonly world: World;
  readonly deps: CaseDeps;
  readonly outbound: FakeOutbound;
  readonly timers: ReturnType<typeof memoryTimers>;
  readonly turns: CaseTurnQueue & { readonly queued: CaseClosedTurn[] };
  readonly network: FakeNetwork;
}

/** Everything the case handlers need over one world; case ids are `case-01J9ZQX…0`, `…1`, … */
export async function caseKit(options: { readonly clockMode?: "PAUSED" | "RUNNING" } = {}): Promise<CaseKit> {
  const world = await caseWorld(options);
  const outbound = policyOutbound(world);
  const timers = memoryTimers(world);
  const queued: CaseClosedTurn[] = [];
  const turns = { queued, enqueueCaseClosed: async (turn: CaseClosedTurn) => void queued.push(turn) };
  const network = fakeNetwork();
  let sequence = 0;
  const deps: CaseDeps = {
    connector: world.connector,
    outbound,
    timers,
    turns,
    network,
    realClock: { now: async () => world.now() },
    logger: createLogger({ level: "error", sink: () => undefined }),
    newCaseId: () => `case-01J9ZQX${(sequence++).toString().padStart(19, "0")}`,
  };
  return { world, deps, outbound, timers, turns, network };
}
