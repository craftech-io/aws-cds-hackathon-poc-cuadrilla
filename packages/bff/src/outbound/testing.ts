// Test support for the pipeline (never imported by runtime code): the demo world of policy/testing.ts
// (Rogelio opted in, Adriana and Héctor on the roster of crew Norte 3, Tuesday 13/10/2026) with his
// orders, the real simulated transport over the memory connector (every send counted), a recording
// SES client, a scripted G2, the deterministic layer of G3 and a timer port that writes `TIMER#` rows.
// Fixtures are the synthetic ones of docs/seed-spec.md.
import { createHash } from "node:crypto";
import type { ApplyGuardrailCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { EmailSendRequestInput } from "../channels/email/request";
import type { EmailSendOutcome } from "../channels/email/outbound";
import { createSimulatedTransport } from "../channels/whatsapp/simulated";
import type { SendRequest, WhatsAppSendResult } from "../channels/whatsapp/transport";
import type { ArmTimerRequest } from "../agent-tools/common/ports";
import { CLOCK, ISP, supervisor, type testConnector, workOrder } from "../connector/testing";
import { resolveBrand } from "../copy/brand";
import type { JsonObject } from "../domain/common";
import { createLogger } from "../lib/log";
import { mx, policyWorld } from "../policy/testing";
import type { OutboundDeps } from "./deps";
import type { G2Input, G2Verdict } from "./grounding";
import { maskParams } from "./g3";
import type { OutboundCall, WhatsAppSendInput } from "./types";

export { mx };

export const NONCE_KEY = new Uint8Array(32).fill(5);
export const TURN = "01JB8Z9Q2W3E4R5T6Y7V8X9TRN";
export const AT_0921 = mx("2026-10-13 09:21");
export const G2_THRESHOLDS = { groundingThreshold: 0.75, relevanceThreshold: 0.5 } as const;

/** G2 that answers what the test scripted (pass by default) and keeps every input it saw. */
export function scriptedG2(verdicts: Array<Partial<G2Verdict>> = []) {
  const inputs: G2Input[] = [];
  return {
    inputs,
    check: async (input: G2Input): Promise<G2Verdict> => {
      inputs.push(input);
      return { action: "NONE", groundingScore: 0.92, relevanceScore: 0.81, ...G2_THRESHOLDS, ...(verdicts.shift() ?? {}) };
    },
  };
}

/** An `ApplyGuardrail` answer with the given scores (grounding_source and relevance filters). */
export function guardrailResponse(scores: { readonly grounding?: number; readonly relevance?: number }, intervened = false): ApplyGuardrailCommandOutput {
  const filters = [
    ...(scores.grounding === undefined ? [] : [{ type: "GROUNDING" as const, threshold: 0.75, score: scores.grounding, action: scores.grounding < 0.75 ? ("BLOCKED" as const) : ("NONE" as const) }]),
    ...(scores.relevance === undefined ? [] : [{ type: "RELEVANCE" as const, threshold: 0.5, score: scores.relevance, action: scores.relevance < 0.5 ? ("BLOCKED" as const) : ("NONE" as const) }]),
  ];
  return { $metadata: {}, action: intervened ? "GUARDRAIL_INTERVENED" : "NONE", outputs: [], assessments: [{ contextualGroundingPolicy: { filters } }], usage: undefined } as unknown as ApplyGuardrailCommandOutput;
}

export interface PipelineKit {
  readonly world: Awaited<ReturnType<typeof policyWorld>>;
  readonly deps: OutboundDeps;
  readonly g2: ReturnType<typeof scriptedG2>;
  /** Every WhatsApp the transport took, in order. */
  readonly sends: SendRequest[];
  readonly emails: EmailSendRequestInput[];
  readonly armed: ArmTimerRequest[];
  readonly logs: Array<Record<string, unknown>>;
  readonly call: OutboundCall;
  /** Stores a tool result of the test turn (`Runtime/TURN#`). */
  result(tool: string, output: JsonObject): Promise<void>;
}

export interface KitOptions {
  readonly g2?: Array<Partial<G2Verdict>>;
  /** Make the WhatsApp transport fail every send with this code. */
  readonly failSends?: boolean;
  /** Replaces the transport's answer (the simulated transport is passed to delegate to); after `failSends`. */
  readonly transport?: (request: SendRequest, simulated: SimulatedSend) => Promise<WhatsAppSendResult>;
}

type SimulatedSend = (request: SendRequest) => Promise<WhatsAppSendResult>;
type TestWorld = ReturnType<typeof testConnector>;

export interface PipelineDeps extends Pick<PipelineKit, "deps" | "g2" | "sends" | "emails" | "armed" | "logs"> {
  readonly log: OutboundCall["log"];
}

/** The pipeline's dependencies over any memory world: the real simulated transport (every send counted), a recording SES client, a scripted G2. */
export function pipelineDeps(world: TestWorld, options: KitOptions = {}): PipelineDeps {
  const { connector } = world;
  const logs: Array<Record<string, unknown>> = [];
  const log = createLogger({ level: "debug", sink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>), now: world.now });
  const realClock = { now: async () => world.now() };
  const simulated = createSimulatedTransport({ conversations: connector.conversations, isps: connector.isps, applyStatuses: async () => [], realClock });
  const sends: SendRequest[] = [];
  const emails: EmailSendRequestInput[] = [];
  const armed: ArmTimerRequest[] = [];
  let seq = 0;
  const g2 = scriptedG2(options.g2);
  const deps: OutboundDeps = {
    connector,
    whatsapp: () => ({
      channel: "WHATSAPP",
      transport: "simulated",
      send: async (request: SendRequest): Promise<WhatsAppSendResult> => {
        sends.push(request);
        if (options.failSends === true) return { ok: false, code: "UNAVAILABLE", reason: "ThrottlingException", retryable: true };
        return options.transport === undefined ? simulated.send(request) : options.transport(request, (asked) => simulated.send(asked));
      },
    }),
    email: {
      send: async (request): Promise<EmailSendOutcome> => {
        emails.push(request);
        const mailId = request.mailId ?? "mail-test";
        return { ok: true, mailId, providerMessageId: `ses-${mailId}`, duplicate: false, mail: {} as never };
      },
    },
    g2,
    g2Limits: () => ({ queryMaxChars: 1000, groundingSourceMaxChars: 100_000 }),
    g3: { check: async (texts) => maskParams(texts) },
    nonces: { runtime: connector.runtime, nonceKey: NONCE_KEY, realClock },
    timers: {
      arm: async (request) => {
        armed.push(request);
        return connector.timers.createTimer({ ...request, status: "SCHEDULED", payload: request.payload ?? {} });
      },
    },
    brand: () => resolveBrand({ mode: "neutral" }),
    registeredRealPhones: () => new Set(),
    demoRecipients: () => [],
    realClock,
    newId: () => `01JB8Z9Q2W3E4R5T6Y7V8X${String((seq += 1)).padStart(4, "0")}`,
  };
  return { deps, g2, sends, emails, armed, logs, log };
}

/** The pipeline over the demo world, with Rogelio's two orders of 13/10 and Adriana and Héctor. */
export async function pipelineKit(options: KitOptions = {}): Promise<PipelineKit> {
  const world = await policyWorld();
  const { connector } = world;
  await connector.workOrders.createWorkOrder(workOrder());
  await connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24818", workOrderNumber: "24818", customerId: "cust-10422" }));
  await connector.people.createPerson(supervisor("sup-adriana", "e".repeat(64)));
  await connector.people.createPerson(supervisor("sup-hector", "f".repeat(64), { phone: "+525501020002" }));
  const { log, ...built } = pipelineDeps(world, options);
  return {
    world,
    ...built,
    call: { actor: "AGENT", correlationId: TURN, log },
    result: async (tool, output) => {
      await connector.runtime.putTurnResult(TURN, tool, output);
    },
  };
}

/** An agent reply to Rogelio on order 24817 in the test turn, answering his message at 09:21. */
export function agentReply(text: string, overrides: Partial<WhatsAppSendInput> = {}): WhatsAppSendInput {
  return { channel: "WHATSAPP", personId: "inst-rogelio", kind: "REPLY", author: "AGENT", eventAtSim: AT_0921, turnId: TURN, workOrderId: "wo-24817", trigger: "INSTALLER_MESSAGE", inResponseToInbound: true, text, ...overrides };
}

/** Rogelio wrote at 09:20 (his 24 h window is open). */
export async function rogelioWrote(kit: Pick<PipelineKit, "world">, text = "¿Cuánto cable sin costo?", atSim = mx("2026-10-13 09:20")): Promise<void> {
  await kit.world.connector.conversations.appendMessage({
    messageId: `wamid.SIM.${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
    personId: "inst-rogelio",
    ispId: ISP,
    clockId: CLOCK,
    direction: "IN",
    channel: "WHATSAPP",
    content: "TEXT",
    text,
    status: "RECEIVED",
    author: "PERSON:inst-rogelio",
    simulated: true,
    sentAtSim: atSim,
  });
  await kit.world.connector.people.recordInbound("inst-rogelio", { atSim });
}
