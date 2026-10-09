// Test support for the worker and the turns (never imported by runtime code): the synthetic world of
// docs/seed-spec.md over the in-memory connector of agent-tools/common/testing.ts (world `GLOBAL#isp-demo`,
// Rogelio with orders 24817 and 24818 on 13/10), a scripted Harness that can answer through the turn's
// session like the agent would, a scripted G1, recording fakes of every port, the in-process `orders` and
// `evidence` targets with fixed answers, and SQS records.
import type { SQSEvent } from "aws-lambda";
import type { z } from "zod";
import { splitSessionToken } from "@cuadrilla/shared";
import type { HarnessClient, HarnessTurnRequest, HarnessTurnResult } from "../agent/harness-client";
import { implementTool, notYetAvailable } from "../agent-tools/common/context";
import { createToolHandler } from "../agent-tools/common/handler";
import { REAL_T0, TURN_AT_SIM, type ToolTestKit, seedDay, toolTestKit } from "../agent-tools/common/testing";
import { EVIDENCE_TOOLS, getChecklistTool } from "../agent-tools/evidence/schema";
import { ORDERS_TOOLS, getWorkOrderTool, getWorkOrdersTool } from "../agent-tools/orders/schema";
import type { Message } from "../domain/conversations";
import { deriveSubkey } from "../lib/crypto";
import { createLogger } from "../lib/log";
import type { NetworkClient } from "../network/client";
import type { GlobalCostCaps } from "../ops/cost-caps";
import type { G1Verdict } from "../turns/prefilter";
import type { TurnReads } from "../turns/preload";
import type { InstallerQueueEventInput } from "./events";
import type { FiredTimer, InstallerRelay, OpenCaseRequest, SafetyClassification, SafetyHandling, TranscriptionOutcome, WorkerNotice, WorkerPorts } from "./ports";
import { createEventSink } from "./sink";
import { type WorkerDeps, createInstallerWorker } from "./worker";

export { REAL_T0, TURN_AT_SIM };
export const ISP = "isp-demo";
export const CLOCK = "GLOBAL#isp-demo";
export const ROGELIO = "inst-rogelio";
export const WO = "wo-24817";
export const MSG = "wamid.SIM.01JB8Z9Q2W3E4R5T6Y7V8X9MSG";
export const RUNTIME_SESSION_KEY = deriveSubkey("test-master-key-test-master-key-00000000", "runtime-session");

/** The stage's ceiling of the tests (ADR-0019 values are larger; these keep the counters readable). */
export const TEST_GLOBAL_CAPS: GlobalCostCaps = { turnsPerDay: 100, validationsPerDay: 50, transcribeSecondsPerDay: 1_000, guestSignup: { turnsPerDay: 20, validationsPerDay: 10, transcribeSecondsPerDay: 100, perUserTurnsPerDay: 10 } };

export interface Recorded {
  readonly harness: HarnessTurnRequest[];
  readonly g1: string[];
  readonly notices: WorkerNotice[];
  readonly cases: OpenCaseRequest[];
  readonly relays: InstallerRelay[];
  readonly safety: SafetyHandling[];
  readonly transcriptions: string[];
  readonly fired: FiredTimer[];
  readonly handled: string[];
  readonly physical: string[];
  readonly queued: InstallerQueueEventInput[];
  readonly reads: string[];
  readonly choices: string[];
}

/** What the scripted Harness does for one invocation: an answer, or throws. */
export type HarnessScript = (request: HarnessTurnRequest, kit: WorkerKit) => Promise<Partial<HarnessTurnResult>>;

export interface WorkerKit {
  readonly tools: ToolTestKit;
  readonly connector: ToolTestKit["memory"]["connector"];
  readonly rec: Recorded;
  readonly deps: WorkerDeps;
  /** Next answers of the scripted Harness (default: one REPLY through the session, `end_turn`). */
  readonly harnessScripts: HarnessScript[];
  readonly g1Verdicts: G1Verdict[];
  transcription: TranscriptionOutcome;
  safetyWords: readonly string[];
  remainingMs: number;
  run(body: unknown, receiveCount?: number): Promise<void>;
  /** The real tool handlers of `orders` and `evidence` with fixed answers, through `createToolHandler`. */
  readonly reads: TurnReads;
}

const OK_USAGE = { inputTokens: 1_200, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The turn's ids from the envelope's signed token, as a tool would read them. */
export function sessionOf(envelope: string): { readonly sessionId: string; readonly turnId: string; readonly token: string } {
  const token = /<session token="([^"]+)"/.exec(envelope)?.[1];
  if (token === undefined) throw new Error("the envelope has no session token");
  const parts = splitSessionToken(token);
  return { sessionId: parts.sessionId, turnId: parts.turnId, token };
}

/** What `send_whatsapp` leaves when the agent answers: a `REPLY` of the turn in the installer's thread. */
export async function agentReply(kit: Pick<WorkerKit, "connector" | "tools">, envelope: string, text = "Va, revisemos la ONU de la orden 24817."): Promise<Message> {
  const { turnId } = sessionOf(envelope);
  return kit.connector.conversations.appendMessage({
    messageId: `msg-out-${turnId}`,
    personId: ROGELIO,
    ispId: ISP,
    clockId: CLOCK,
    direction: "OUT",
    channel: "WHATSAPP",
    content: "TEXT",
    kind: "REPLY",
    workOrderId: WO,
    text,
    status: "SENT",
    author: "AGENT",
    turnId,
    simulated: true,
    sentAtSim: TURN_AT_SIM,
    sentAtReal: new Date(kit.tools.memory.now().getTime() + 4_000).toISOString(),
  });
}

export const replyScript: HarnessScript = async (request, kit) => {
  await agentReply(kit, request.envelope);
  return { outcome: "COMPLETED", stopReason: "end_turn", note: "Respondí con el paso siguiente." };
};

function scriptedHarness(kit: () => WorkerKit): HarnessClient {
  return {
    async invoke(request) {
      const current = kit();
      current.rec.harness.push(request);
      const script = current.harnessScripts.shift() ?? replyScript;
      const answer = await script(request, current);
      return { outcome: "COMPLETED", stopReason: "end_turn", note: "", usage: OK_USAGE, toolUses: 1, attempts: 1, ...answer };
    },
  };
}

type Output<T extends { readonly output: z.ZodType }> = { readonly ok: true } & z.input<T["output"]>;

const ORDER_SUMMARY = { workOrderNumber: "24817", status: "SCHEDULED" as const, customerFirstName: "Lucía", addressLine: "Calle Ficticia 5 <Norte> & Sur", neighborhood: "Col. Inventada", plan: "Fibra 300", windowText: "hoy 9:00 a 11:00" };

/** `orders` and `evidence` in process, with fixed answers that match their output schemas. */
function fakeReads(tools: ToolTestKit, rec: Recorded): TurnReads {
  const orders = createToolHandler({
    target: "orders",
    deps: () => tools.runtime,
    tools: [
      implementTool(getWorkOrdersTool, async () => {
        rec.reads.push("get_work_orders");
        return { ok: true, installerFirstName: "Rogelio", dayText: "hoy, martes 13 de octubre", workOrders: [{ ...ORDER_SUMMARY, isActive: true, openCase: false }], recentWorkOrders: [{ workOrderNumber: "24817", status: "SCHEDULED", dayText: "hoy", open: true }], nowSimText: "9:20" } satisfies Output<typeof getWorkOrdersTool>;
      }),
      implementTool(getWorkOrderTool, async () => {
        rec.reads.push("get_work_order");
        return {
          ok: true,
          workOrder: { ...ORDER_SUMMARY, onuSerial: "DEMO3F2C19A0", onuModel: "ONU-G1", oltPort: "OLT-N3/1/4", opticalClass: "B+" as const, acceptanceRange: { minDbm: -27, maxDbm: -8, text: "entre -27 y -8 dBm" }, onHoldSafety: false },
          checklist: [{ item: "ONU_ONLINE", status: "PENDING", attempts: 0 }],
          troubleshooting: [],
          facts: { tips: [] },
        } satisfies Output<typeof getWorkOrderTool>;
      }),
      ...ORDERS_TOOLS.filter((definition) => definition.name === "get_onu_status").map((definition) => notYetAvailable(definition)),
    ],
  });
  const evidence = createToolHandler({
    target: "evidence",
    deps: () => tools.runtime,
    tools: [
      implementTool(getChecklistTool, async () => {
        rec.reads.push("get_checklist");
        return { ok: true, items: [{ item: "ONU_ONLINE", label: "ONU en línea", status: "PENDING", attempts: 0 }], complete: false } satisfies Output<typeof getChecklistTool>;
      }),
      ...EVIDENCE_TOOLS.filter((definition) => definition.name !== "get_checklist").map((definition) => notYetAvailable(definition)),
    ],
  });
  return { orders, evidence };
}

function fakePorts(kit: () => WorkerKit, rec: Recorded): WorkerPorts {
  const handled = (name: string) => async () => {
    rec.handled.push(name);
  };
  return {
    transcriber: {
      async transcribe(request) {
        rec.transcriptions.push(request.message.messageId);
        const outcome = kit().transcription;
        if (outcome.status === "TRANSCRIBED") {
          const { message } = request;
          await kit().connector.conversations.updateMessage({ personId: message.personId, sentAtSim: message.sentAtSim, messageId: message.messageId }, { transcript: { text: outcome.text, confidence: outcome.confidence } });
        }
        return outcome;
      },
    },
    safety: {
      async classify(text): Promise<SafetyClassification> {
        const lower = text.toLowerCase();
        return kit().safetyWords.some((word) => lower.includes(word)) ? { matched: true, category: "ELECTRICAL", lexiconVersion: "v001" } : { matched: false };
      },
      handle: async (input) => {
        rec.safety.push(input);
      },
    },
    cases: {
      openCase: async (request) => {
        rec.cases.push(request);
        return { caseId: "case-01J9ZQX0000000000000000009" };
      },
      relayFromInstaller: async (relay) => {
        rec.relays.push(relay);
      },
      supervisorAction: handled("SUPERVISOR_ACTION"),
      preset: handled("CASE_PRESET"),
    },
    notices: {
      send: async (notice) => {
        rec.notices.push(notice);
      },
    },
    orderChoice: {
      send: async (request) => {
        rec.choices.push(request.sourceMessageId);
        return "SENT";
      },
    },
    timers: {
      async fire(request) {
        rec.handled.push(`fire:${request.timerKey}`);
        const timer = { entity: "Timer", kind: "DAY_START", timerId: "day-start-inst-rogelio", home: { kind: "WORK_ORDER", id: WO }, clockId: CLOCK, dueAtSim: TURN_AT_SIM, status: "FIRED", version: 2, createdAt: REAL_T0, updatedAt: REAL_T0 } as never;
        if (request.timerKey.includes("STALE")) return { status: "STALE", timer, reason: "VERSION" };
        if (request.timerKey.includes("LATER")) return { status: "NOT_DUE", timer };
        return { status: "FIRED", timer, eventAtSim: TURN_AT_SIM };
      },
    },
    timerHandlers: {
      dayStart: async (fired) => {
        rec.fired.push(fired);
      },
      caseTimeout: handled("CASE_TIMEOUT"),
      deferredSend: handled("DEFERRED_SEND"),
      certRetry: handled("CERT_RETRY"),
    },
    handlers: { applyDispatchEvent: handled("DISPATCH_EVENT"), applyEmailEvent: handled("EMAIL_EVENT"), outboundSend: handled("OUTBOUND_SEND") },
    buttons: {
      actions: { openConsultCase: handled("CONSULT_SUPERVISOR"), closeInstallation: async () => ({ ok: true }), recordCustomerOk: handled("CUSTOMER_OK") },
      notices: { send: handled("BUTTON_NOTICE") },
    },
    probes: [{ name: "network", health: async () => true }],
  };
}

function fakeNetwork(rec: Recorded): Pick<NetworkClient, "reportPhysicalAction"> {
  return {
    async reportPhysicalAction(call) {
      rec.physical.push(`${call.serial}:${call.kind}`);
      return { kind: "OK", value: { serial: call.serial } as never, attempts: 1 };
    },
  };
}

/** The demo world at 09:20 of 13/10 (paused), Rogelio's day, his consent and his active order 24817. */
export async function seedWorld(kit: Pick<WorkerKit, "connector" | "tools">, options: { readonly clockId?: string; readonly ispId?: string } = {}): Promise<void> {
  const clockId = options.clockId ?? CLOCK;
  const ispId = options.ispId ?? ISP;
  await seedDay(kit.tools);
  await kit.connector.runtime.createClock({ clockId, ispId, kind: "DEMO", mode: "PAUSED", offsetMs: 0, pausedSimNow: TURN_AT_SIM, worldEpoch: 3 });
  await kit.connector.isps.putSettings({
    ispId,
    clockId,
    quietHours: { start: "21:00", end: "07:00" },
    caseTimeoutSec: 600,
    demoMode: false,
    demoCaseTimeoutSec: 60,
    whatsappMode: "simulated",
    turnCaps: { perHour: 200, perDay: 1_000 },
    simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1_800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 60 },
  });
  await kit.connector.worlds.setActiveWorkOrder(ROGELIO, clockId, WO, TURN_AT_SIM);
}

/** An installer's stored inbound message (the channel already masked it). */
export async function inboundMessage(kit: Pick<WorkerKit, "connector">, fields: Partial<Message> = {}): Promise<Message> {
  return kit.connector.conversations.appendMessage({
    messageId: MSG,
    personId: ROGELIO,
    ispId: ISP,
    clockId: CLOCK,
    direction: "IN",
    channel: "WHATSAPP",
    content: "TEXT",
    text: "Ya estoy con la clienta, la ONU no prende la luz PON",
    workOrderId: WO,
    status: "RECEIVED",
    author: `PERSON:${ROGELIO}`,
    simulated: true,
    transport: "simulated",
    providerMessageId: fields.messageId ?? MSG,
    sentAtSim: TURN_AT_SIM,
    sentAtReal: REAL_T0,
    ...fields,
  });
}

/** The `INBOUND_MESSAGE` InboundWhatsApp enqueues for `message`. */
export function inboundEvent(message: Pick<Message, "messageId" | "sentAtSim">, eventId = "wa-in-0000000000000000000000000000000000000001"): InstallerQueueEventInput {
  return { type: "INBOUND_MESSAGE", eventId, clockId: CLOCK, ispId: ISP, installerId: ROGELIO, message: { personId: ROGELIO, sentAtSim: message.sentAtSim, messageId: message.messageId } };
}

export function sqsEvent(body: unknown, receiveCount = 1): SQSEvent {
  return {
    Records: [
      {
        messageId: "sqs-1",
        receiptHandle: "rh-1",
        body: typeof body === "string" ? body : JSON.stringify(body),
        attributes: { ApproximateReceiveCount: String(receiveCount), SentTimestamp: "0", SenderId: "x", ApproximateFirstReceiveTimestamp: "0" },
        messageAttributes: {},
        md5OfBody: "",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:000000000000:q.fifo",
        awsRegion: "us-east-1",
      },
    ],
  };
}

export function workerKit(): WorkerKit {
  const tools = toolTestKit();
  const rec: Recorded = { harness: [], g1: [], notices: [], cases: [], relays: [], safety: [], transcriptions: [], fired: [], handled: [], physical: [], queued: [], reads: [], choices: [] };
  let self: WorkerKit | undefined;
  const get = (): WorkerKit => {
    if (self === undefined) throw new Error("kit not ready");
    return self;
  };
  const connector = tools.memory.connector;
  const realClock = { now: async () => tools.memory.now() };
  const g1Verdicts: G1Verdict[] = [];
  const reads = fakeReads(tools, rec);
  let draws = 0;
  const deps: WorkerDeps = {
    data: connector,
    turn: {
      harness: scriptedHarness(get),
      prefilter: {
        async check(text) {
          rec.g1.push(text);
          return g1Verdicts.shift() ?? { action: "NONE" };
        },
      },
      budget: { kill: tools.runtime.killSwitch, costCaps: { store: tools.store, kill: tools.runtime.killSwitch, globalCaps: () => TEST_GLOBAL_CAPS, realClock } },
      sessionKey: tools.runtime.sessionKey,
      runtimeSessionKey: () => RUNTIME_SESSION_KEY,
      agentMode: "SCRIPTED",
      reads,
      random: (size) => {
        draws += 1;
        return Uint8Array.from({ length: size }, (_, index) => (index * 37 + draws * 101) % 256);
      },
    },
    ports: fakePorts(get, rec),
    network: fakeNetwork(rec),
    sink: createEventSink({
      data: connector,
      send: async (message) => {
        rec.queued.push(JSON.parse(message.body) as InstallerQueueEventInput);
      },
    }),
    now: () => tools.memory.now(),
    loggerFor: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => tools.logs.push(JSON.parse(line) as Record<string, unknown>), now: tools.memory.now }),
  };
  const kit: WorkerKit = {
    tools,
    connector,
    rec,
    deps,
    harnessScripts: [],
    g1Verdicts,
    transcription: { status: "TRANSCRIBED", text: "Ya estoy con la clienta, la ONU no prende la luz PON", confidence: 0.93 },
    safetyWords: ["chispeando", "cable pelado"],
    remainingMs: 340_000,
    reads,
    async run(body, receiveCount = 1) {
      await createInstallerWorker(deps)(sqsEvent(body, receiveCount), { getRemainingTimeInMillis: () => kit.remainingMs });
    },
  };
  self = kit;
  return kit;
}

/** A cap counter already at `used` (the memory store keeps `{ used, limit }` per key). */
export function fillCounter(kit: Pick<WorkerKit, "tools">, key: string, used: number, limit: number): void {
  (kit.tools.store.items as Map<string, Record<string, unknown>>).set(key, { used, limit });
}

/** Log lines that carry `metric`. */
export function metricLines(kit: Pick<WorkerKit, "tools">, metric: string): Array<Record<string, unknown>> {
  return kit.tools.logs.filter((line) => line.metric === metric);
}
