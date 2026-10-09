// Test kit of the evaluation (never imported by a Lambda): a measurement world built by the real factory
// over memory (`worldsHarness`, the committed templates and photo catalog, the `Reference` rows of the
// seed), and the evaluation's ports wired to what runs locally at no cost:
//
//   photos      the real `validate_install_photo` with a `QA` caller, the scripted validator of the set
//               (scripts/seed/photos/scripted-verdicts.json, `source: SCRIPTED`), the photos' bytes in a
//               memory `Media`, and an orchestrator that reads the world's `Network` rows
//   questions   a scripted channel: each question is answered by a script that writes what the worker,
//               the pipeline and the guardrail would leave (messages, turn notes, turn results, cases,
//               audit), so the reading and the scoring run over the connector's real shapes
import { readFileSync } from "node:fs";
import { createEvidenceTarget } from "../agent-tools/evidence/index";
import type { EvidenceToolRuntime } from "../agent-tools/evidence/runtime";
import { deriveSubkey } from "../lib/crypto";
import { createLogger } from "../lib/log";
import type { Item } from "../connector/table-client";
import { memoryObjects, scriptedModel, setPhoto } from "../evidence/testing";
import type { NetworkClient } from "../network/client";
import { createKillSwitchReader } from "../ops/kill-switch";
import { createMemoryRuntimeStore } from "../ops/memory-runtime-store";
import type { CaseReason } from "@cuadrilla/shared";
import { openCase } from "../connector/testing";
import { createWorld } from "../worlds/worlds";
import { type WorldsHarness, worldsHarness } from "../worlds/testing";
import { loadTemplate } from "../worlds/templates";
import { presetOnuSetter } from "./index";
import type { EvalChannel, EvalDeps } from "./ports";
import { type EvalKind, evalWorldRequest } from "./world-request";

const REFERENCE_ITEMS = (JSON.parse(readFileSync(new URL("../../../../scripts/seed/data/Reference.json", import.meta.url), "utf8")) as { items: Item[] }).items;
const SESSION_KEY = deriveSubkey("test-master-key-test-master-key-00000000", "session");

export const GLOBAL_CAPS = { turnsPerDay: 1000, validationsPerDay: 200, transcribeSecondsPerDay: 3600 };

export interface EvalHarness {
  readonly harness: WorldsHarness;
  readonly deps: EvalDeps;
  readonly clockId: string;
  /** Validations the scripted model was asked for (a duplicate never reaches it). */
  readonly modelCalls: () => number;
}

const NO_CHANNEL: EvalChannel = {
  sendText: async () => Promise.reject(new Error("no channel in this harness")),
  tapButton: async () => Promise.reject(new Error("no channel in this harness")),
  settleInstaller: async () => undefined,
};

/** The orchestrator's reading of each ONU, from the world's own `Network` rows (what the mock serves). */
function tableNetwork(harness: WorldsHarness): Pick<NetworkClient, "getOnuStatus"> {
  return {
    async getOnuStatus(call) {
      const row = await harness.client.get("Network", { PK: `ONU#${call.clockId}#${call.serial}`, SK: "META" });
      if (row === undefined) return { kind: "UNAVAILABLE", reason: "HTTP_5XX", attempts: 1 };
      const rx = typeof row.rxPowerDbm === "number" ? row.rxPowerDbm : undefined;
      return { kind: "OK", attempts: 1, value: { serial: call.serial, operState: rx === undefined ? "LOS" : "ONLINE", observedAt: call.atSim, ...(rx === undefined ? {} : { rxPowerDbm: rx }) } };
    },
  };
}

/** A measurement world of `kind` built by the real factory, with the evaluation's ports over memory. */
/** The world a channel answers in: the harness and the measurement world's clock. */
export interface WorldRef {
  readonly harness: WorldsHarness;
  readonly clockId: string;
}

export async function evalHarness(kind: EvalKind, options: { readonly channel?: (world: WorldRef) => EvalChannel; readonly suiteRunId?: string } = {}): Promise<EvalHarness> {
  const harness = worldsHarness({ start: "2026-10-13T13:00:00.000Z" });
  await harness.connector.seed.loadItems("Reference", REFERENCE_ITEMS);
  const template = await loadTemplate(harness.deps.templates, "eval");
  const created = await createWorld(harness.deps, evalWorldRequest(template, options.suiteRunId ?? "local-1", kind));
  if (created.kind !== "EVAL") throw new Error("expected an evaluation world");
  const { clockId } = created.world;
  const objects = memoryObjects();
  for (const [key, photoId] of harness.media) objects.media.set(key, setPhoto(photoId).bytes);
  const model = scriptedModel();
  const store = createMemoryRuntimeStore();
  const realClock = { now: async () => harness.now() };
  const runtime: EvidenceToolRuntime = {
    connector: harness.connector,
    killSwitch: createKillSwitchReader({ store, realClock, ttlMs: 0 }),
    sessionKey: () => SESSION_KEY,
    realClock,
    loggerFor: (correlationId) => createLogger({ correlationId, sink: () => undefined, now: harness.now }),
    photoModel: model,
    objects,
    network: tableNetwork(harness),
    capStore: store,
    globalCaps: () => GLOBAL_CAPS,
    cases: { openPhotoAttemptsCase: async () => ({ caseId: "case-01J9ZQX0000000000000000009", reason: "PHOTO_ATTEMPTS" }) },
    outbound: { reactToPhoto: async () => undefined, photoNotice: async () => undefined },
  };
  const target = createEvidenceTarget(() => runtime);
  const deps: EvalDeps = {
    connector: harness.connector,
    client: harness.client,
    channel: options.channel?.({ harness, clockId }) ?? NO_CHANNEL,
    tools: {
      validatePhoto: (call) => target.invoke("validate_install_photo", { caller: { kind: "QA", ispId: call.ispId, clockId: call.clockId }, candidateId: call.candidateId, item: call.item }, { subject: { installerId: call.installerId, workOrderId: call.workOrderId } }),
      setOnu: presetOnuSetter(harness.deps),
    },
    evalTemplate: async () => template,
    log: createLogger({ sink: () => undefined }),
    now: () => harness.now(),
    callKey: "local-1/EV/2/m1",
  };
  return { harness, deps, clockId, modelCalls: () => model.calls.length };
}

// ---- Scripted answers of the questions --------------------------------------------------------------

const AT_SIM = "2026-10-13T07:00:00-06:00";
let sequence = 0;
const nextId = (prefix: string): string => `${prefix}-${String((sequence += 1)).padStart(5, "0")}`;

/** What the worker, the pipeline and the guardrail would leave for a question, written over the connector. */
export interface AnswerWorld {
  reply(installerId: string, text: string, options?: { readonly citations?: readonly string[]; readonly author?: "AGENT" | "SYSTEM"; readonly kind?: "REPLY" | "SYSTEM_NOTICE" | "SAFETY_INSTRUCTION"; readonly button?: "CONSULT_SUPERVISOR"; readonly turnId?: string }): Promise<void>;
  /** A turn of the agent: its `search_procedures` result (sections with scores) and its note with the usage. */
  turn(installerId: string, turnId: string, sections: ReadonlyArray<readonly [string, number]>, usage?: { readonly inputTokens: number; readonly outputTokens: number }): Promise<void>;
  openCase(installerId: string, kind: "ESCALATION" | "SAFETY", reason: CaseReason): Promise<void>;
  /** `GUARDRAIL_BLOCK` audited on the installer's order. */
  block(installerId: string, policy: string, topics: readonly string[]): Promise<void>;
}

/** Writes the answer of one question (by its id) as its installer would get it. */
export type AnswerScript = (world: AnswerWorld, installerId: string, questionId: string) => Promise<void>;

async function orderOf(world: WorldRef, installerId: string): Promise<{ readonly workOrderId: string; readonly ispId: string }> {
  const state = await world.harness.connector.worlds.getInstallerState(installerId);
  const order = await world.harness.connector.workOrders.requireWorkOrder(state?.activeWorkOrderId ?? "");
  return { workOrderId: order.workOrderId, ispId: order.ispId };
}

function answerWorld(world: WorldRef): AnswerWorld {
  const { connector } = world.harness;
  const { clockId } = world;
  return {
    async reply(installerId, text, options = {}) {
      world.harness.advance(4_000);
      const { workOrderId, ispId } = await orderOf(world, installerId);
      const interactive = options.button === undefined ? {} : { interactive: { type: "button", buttons: [{ id: nextId("nonce"), title: "Consultar", action: options.button }] } };
      await connector.conversations.appendMessage({
        messageId: nextId("msg"),
        personId: installerId,
        ispId,
        clockId,
        direction: "OUT",
        channel: "WHATSAPP",
        content: options.button === undefined ? "TEXT" : "INTERACTIVE",
        kind: options.kind ?? "REPLY",
        workOrderId,
        text,
        status: "SENT",
        author: options.author ?? "AGENT",
        simulated: true,
        sentAtSim: AT_SIM,
        ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
        ...(options.citations === undefined ? {} : { refs: { citations: [...options.citations] } }),
        ...interactive,
      });
    },
    async turn(installerId, turnId, sections, usage = { inputTokens: 1200, outputTokens: 300 }) {
      const { workOrderId } = await orderOf(world, installerId);
      await connector.runtime.putTurnResult(turnId, "search_procedures", { coverage: sections.length > 0 ? "FOUND" : "NONE", passages: sections.map(([sectionId, score]) => ({ sectionId, title: sectionId, text: "…", score })), citationFormat: "(Manual v1, §XXX-00)" });
      await connector.conversations.appendTurnNote({ turnId, personId: installerId, clockId, workOrderId, trigger: "INSTALLER_MESSAGE", note: "nota", usage, latencyMs: 4000, atSim: AT_SIM, stopReason: "end_turn" });
    },
    async openCase(installerId, kind, reason) {
      world.harness.advance(2_000);
      const { workOrderId, ispId } = await orderOf(world, installerId);
      await connector.cases.createCase(openCase({ caseId: `case-01J9ZQX00000000000000${String((sequence += 1)).padStart(5, "0")}`, ispId, clockId, workOrderId, installerId, kind, reason }));
    },
    async block(installerId, policy, topics) {
      const { workOrderId, ispId } = await orderOf(world, installerId);
      await connector.audit.append({ ispId, clockId, atSim: AT_SIM, decision: "DENY", action: "GUARDRAIL_BLOCK", actor: "WORKER", ruleIds: ["G1"], refs: { workOrderId }, detail: { origin: "PREFILTER", policy, topics: [...topics] } });
    },
  };
}

export interface AnsweringRecord {
  readonly sent: Array<{ readonly installerId: string; readonly questionId?: string }>;
  readonly taps: string[];
}

/**
 * A channel whose installers get the answers of `script`: the question goes in as the simulator would put
 * it, the script writes the answer, and a tap of the offer opens the `OUT_OF_MANUAL` case.
 */
export function answeringChannel(script: AnswerScript, record: AnsweringRecord = { sent: [], taps: [] }): (world: WorldRef) => EvalChannel {
  return (world) => {
    const answers = answerWorld(world);
    let texts: Map<string, string> | undefined;
    const questionOf = async (text: string): Promise<string | undefined> => {
      texts ??= new Map((await world.harness.connector.reference.listEvalQuestions()).map((row) => [row.text, row.questionId]));
      return texts.get(text);
    };
    return {
      async sendText({ installerId, text }) {
        const { workOrderId, ispId } = await orderOf(world, installerId);
        world.harness.advance(2_000);
        const messageId = nextId("wamid.SIM.in");
        await world.harness.connector.conversations.appendMessage({ messageId, personId: installerId, ispId, clockId: world.clockId, direction: "IN", channel: "WHATSAPP", content: "TEXT", workOrderId, text, status: "RECEIVED", author: `PERSON:${installerId}`, simulated: true, sentAtSim: AT_SIM });
        const questionId = await questionOf(text);
        record.sent.push({ installerId, ...(questionId === undefined ? {} : { questionId }) });
        if (questionId !== undefined) await script(answers, installerId, questionId);
        return { messageId };
      },
      async tapButton({ installerId, action }) {
        record.taps.push(`${installerId}:${action}`);
        await answers.openCase(installerId, "ESCALATION", "OUT_OF_MANUAL");
      },
      settleInstaller: async () => undefined,
    };
  };
}

/** Answers every question the way its first accepted outcome reads (a run that meets every threshold). */
export function idealAnswers(questions: ReadonlyMap<string, { readonly acceptedOutcomes: readonly string[]; readonly expectedSections: readonly string[] }>): AnswerScript {
  return async (world, installerId, questionId) => {
    const question = questions.get(questionId);
    const first = question?.acceptedOutcomes[0] ?? "REFUSAL";
    const section = /^CITED_ANSWER\(([A-Z]+-\d{2})/.exec(first)?.[1];
    const topic = /^GUARDRAIL_BLOCK\(([A-Z_]+)\)$/.exec(first)?.[1];
    const turnId = nextId(`turn-${questionId}`);
    if (section !== undefined) {
      await world.turn(installerId, turnId, [[section, 0.68]]);
      await world.reply(installerId, `Según el manual, revisa el procedimiento (Manual v1, §${section}).`, { citations: [section], turnId });
    } else if (topic !== undefined) {
      await world.block(installerId, topic === "PROMPT_ATTACK" ? "PROMPT_ATTACK" : "DENIED_TOPIC", topic === "PROMPT_ATTACK" ? [] : [topic]);
      await world.reply(installerId, "Eso no lo puedo responder por aquí. Tu supervisor de turno va a revisar tu consulta.", { author: "SYSTEM", kind: "SYSTEM_NOTICE" });
      await world.openCase(installerId, "ESCALATION", "DENIED_TOPIC");
    } else if (first === "OFFER_ESCALATION") {
      await world.turn(installerId, turnId, []);
      await world.reply(installerId, "Eso no está en el manual. ¿Quieres que lo consulte con tu supervisor?", { button: "CONSULT_SUPERVISOR", turnId });
    } else {
      await world.reply(installerId, "No tengo esa información; lo paso a tu supervisor.");
      await world.openCase(installerId, "ESCALATION", "OUT_OF_MANUAL");
    }
  };
}
