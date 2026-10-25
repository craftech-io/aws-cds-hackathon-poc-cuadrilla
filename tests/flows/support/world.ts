// The in-process world of the local flows (docs/test-plan.md §3, "Flujos locales"): the seed loaded the
// way `seed:load` loads it (the static `Reference` rows, then the demo world `GLOBAL#isp-demo` by the
// world factory from its committed template, phone hashes and certificates included) plus the rehearsal
// guest world `GUEST#isp-guest-test` from the `guest` template, the stage's modules wired over it
// (stage.ts, targets.ts, worker.ts), the simulated systems in process (mocks.ts), every AWS call faked at
// the call (aws.ts) and the scripted Harness behind the local Gateway (gateway.ts, scripted-harness.ts).
//
// It exposes the entries the stage has: the phone (the simulator's signed envelope into
// `InboundWhatsApp`), SES's events (`ChannelEvents`), the dispatcher (`FeedEvents`), the clock
// (`advance_clock` as the `QaDriver` calls it) and the installer queue, drained by the `InstallerWorker`.
// Real time stands still and only moves when a person does something on the phone (`PHONE_PAUSE_MS`) or a
// test moves it; simulated time is each world's clock, which only the clock module moves (ADR-0010).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ClockId, DEMO_CLOCK_ID, DEMO_ISP_ID, type WaButtonAction } from "@cuadrilla/shared";
import { simMediaKey } from "@cuadrilla/shared/media/keys";
import { type ClockTarget, advanceClock } from "../../../packages/bff/src/clock/advance";
import type { ClockMoved } from "../../../packages/bff/src/clock/state";
import { processEmailEvent } from "../../../packages/bff/src/feeds/email-events";
import { type InboundResult, processInboundEvent } from "../../../packages/bff/src/channels/whatsapp/inbound";
import { type SimulatedContent, buildSimulatedEvent, simulatorWamid } from "../../../packages/bff/src/channels/whatsapp/sim-envelope";
import { type Recorded, fakeSocial, liveEvent, recorder, waText } from "../../../packages/bff/src/channels/whatsapp/testing";
import { type MemoryConnector, createMemoryConnector } from "../../../packages/bff/src/connector/index";
import type { Item } from "../../../packages/bff/src/connector/table-client";
import type { Decision } from "../../../packages/bff/src/domain/audit";
import type { Message } from "../../../packages/bff/src/domain/conversations";
import { createLogger } from "../../../packages/bff/src/lib/log";
import { buttonsOf, payloadOf } from "../../../packages/bff/src/routers/simulator-views";
import { buttonText } from "../../../packages/bff/src/story/render";
import { historicalCertificates } from "../../../packages/bff/src/worlds/certificates";
import { RenderAllocator } from "../../../packages/bff/src/worlds/photo-catalog";
import { casePresetEffects } from "../../../packages/bff/src/worlds/preset-effects";
import { type AppliedPreset, applyOrderPreset } from "../../../packages/bff/src/worlds/presets";
import { OrderPreset } from "../../../packages/bff/src/worlds/templates";
import { createDemoWorld } from "../../../packages/bff/src/worlds/demo";
import type { WorldsDeps } from "../../../packages/bff/src/worlds/deps";
import { buildWorld } from "../../../packages/bff/src/worlds/factory";
import { PHOTO_INDEX, TEMPLATE_TEXT, memoryWorlds, photoBytes } from "../../../packages/bff/src/worlds/testing";
import { type GuardrailFake, type KnowledgeFake, type SesFake, guardrailFake, knowledgeFake, sesFake, transcribeFake, voiceBytes } from "./aws";
import { type LocalGateway, createLocalGateway, localPolicies } from "./gateway";
import { type LocalDispatch, type LocalNetwork, localDispatch, localNetwork } from "./mocks";
import { type FlowObjects, flowObjects } from "./objects";
import { type LocalQueue, localQueue } from "./queue";
import { type Plan, type PlanSource, type ScriptedHarness, createScriptedHarness } from "./scripted-harness";
import { type Stage, LOCAL_EMAIL_CONFIG, createStage } from "./stage";
import { type Targets, createTargets } from "./targets";
import { type LocalHarnessSeam, type LocalWorker, createLocalWorker } from "./worker";
import { defaultAgent } from "./agent";

/** Real instant of a fresh world: 07:00 of the demo day in Mexico City. */
export const REAL_START = "2026-10-13T13:00:00.000Z";
/** Real time between two things a person does on the phone (an identity sends at most 20 per real hour). */
export const PHONE_PAUSE_MS = 200_000;
export const GUEST_TEST_ISP = "isp-guest-test";
export const GUEST_TEST_CLOCK = `GUEST#${GUEST_TEST_ISP}`;
/** The console user of the simulator's uploads (the `QaDriver`'s supervisor). */
export const UPLOADER = "usr-qa-sup";
/** The demo day starts here; the seed's history (12/10) is before it. */
export const DEMO_DAY_START = "2026-10-13T06:00:00.000Z";

const REFERENCE_FILE = join(import.meta.dirname, "../../../scripts/seed/data/Reference.json");

export interface FlowWorldOptions {
  /** The plans of every turn no test queued (`harness.next`); the default agent otherwise (agent.ts). */
  readonly agent?: PlanSource;
  /**
   * A Harness in place of the scripted one (tests/agent: the kit's model behind the same Gateway); the
   * scripted Harness still exists, unused.
   */
  readonly harness?: (gateway: LocalGateway) => LocalHarnessSeam;
  /** Cedar with the kill switch statement (`CED-KILL-SWITCH`). */
  readonly cedarKillSwitch?: boolean;
  /** The stage has the live transport too (P-01): an EUM Social stand-in records what it sends. */
  readonly live?: boolean;
}

export interface Sent {
  readonly wamid: string;
  readonly result: InboundResult;
}

export interface FlowWorld {
  readonly memory: MemoryConnector;
  readonly data: MemoryConnector["connector"];
  readonly stage: Stage;
  readonly targets: Targets;
  readonly gateway: LocalGateway;
  readonly harness: ScriptedHarness;
  readonly worker: LocalWorker;
  readonly worlds: WorldsDeps;
  readonly objects: FlowObjects;
  readonly queue: LocalQueue;
  readonly network: LocalNetwork;
  readonly dispatch: LocalDispatch;
  readonly guardrails: GuardrailFake;
  readonly ses: SesFake;
  readonly knowledge: KnowledgeFake;
  readonly transcribe: ReturnType<typeof transcribeFake>;
  /** What the EUM Social stand-in was asked (only with `live`). */
  readonly social: Recorded;
  /** Every log line of the stage's modules, parsed. */
  readonly logs: Array<Record<string, unknown>>;
  readonly clockId: string;
  readonly ispId: string;
  realNow(): Date;
  advanceReal(ms: number): void;
  /** Simulated now of a world (the demo world's by default), ISO in UTC. */
  simNow(clockId?: string): Promise<string>;
  /** `advance_clock` as the `QaDriver` calls it (no busy gate), then the world settles. */
  advance(target: ClockTarget, clockId?: string): Promise<ClockMoved>;
  /** The clock to `HH:MM` of its day (Mexico City), then the world settles. */
  at(time: string, clockId?: string): Promise<ClockMoved>;
  /** Drains the installer queue and answers SES's events until nothing is left. */
  settle(): Promise<void>;
  /**
   * A preset of `world.create` on an order (worlds/presets.ts, what the QaDriver and "Saltar a escena" seed):
   * checklist, ONU, case, steps, offered buttons, candidates, profile, at the world's now.
   */
  preset(workOrderId: string, preset: OrderPreset): Promise<AppliedPreset>;
  /** Queues the plans of the next agent turns, in order. */
  plan(...plans: Plan[]): void;
  /** A live text from a real phone, as EUM Social publishes it to the app's topic, then the world settles. */
  sendLive(phone: string, body: string): Promise<Sent>;
  /** A person of the world sends `content` from the simulator, then the world settles. */
  send(personId: string, content: SimulatedContent, clockId?: string): Promise<Sent>;
  /** A number of the world's block nobody registered (or any synthetic number) sends `content`. */
  sendFrom(phone: string, content: SimulatedContent, clockId?: string): Promise<Sent>;
  text(personId: string, body: string, clockId?: string): Promise<Sent>;
  voice(personId: string, voiceId: string, clockId?: string): Promise<Sent>;
  photo(personId: string, photo: string | { readonly bytes: Uint8Array; readonly mime?: string }, clockId?: string): Promise<Sent>;
  /** Taps the button `action` (or a row whose title or description contains `title`) of the last message that offers it. */
  tap(personId: string, button: WaButtonAction | { readonly title: string }, clockId?: string): Promise<Sent>;
  /** The person's thread in order (`sentAtSim`, then real time of storage). */
  thread(personId: string): Promise<Message[]>;
  /** What actually reached the person on the demo day (not denied, deferred or failed), optionally of one kind. */
  delivered(personId: string, kind?: Message["kind"]): Promise<Message[]>;
  /** The audit log of an operator (the demo's by default) for October 2026, oldest first. */
  decisions(ispId?: string): Promise<Decision[]>;
  /** What went out to the person on the demo day (13/10) or later, optionally of one kind. */
  outbound(personId: string, kind?: Message["kind"]): Promise<Message[]>;
}

/**
 * The buttons a phone shows for an outbound message: its stored WhatsApp payload, or (a button the world
 * factory seeded with the `offer` preset, which keeps only `interactive`) its reply buttons.
 */
function buttonsOfMessage(message: Message): Array<{ readonly id: string; readonly title: string; readonly kind: "button" | "button_reply" | "list_reply"; readonly description?: string }> {
  const rows = ((message.interactive?.rows ?? []) as Array<{ id?: unknown; description?: unknown }>).flatMap((row) => (typeof row.id === "string" && typeof row.description === "string" ? [[row.id, row.description] as const] : []));
  const described = new Map(rows);
  const fromPayload = buttonsOf(payloadOf(message)).map((button) => ({ ...button, ...(described.has(button.id) ? { description: described.get(button.id) } : {}) }));
  if (fromPayload.length > 0) return fromPayload;
  const seeded = (message.interactive?.buttons ?? []) as Array<{ id?: unknown; title?: unknown }>;
  return seeded.flatMap((button) => (typeof button.id === "string" && typeof button.title === "string" ? [{ id: button.id, title: button.title, kind: "button_reply" as const }] : []));
}

async function referenceRows(): Promise<Item[]> {
  return (JSON.parse(readFileSync(REFERENCE_FILE, "utf8")) as { items: Item[] }).items;
}

export async function createFlowWorld(options: FlowWorldOptions = {}): Promise<FlowWorld> {
  let realMs = Date.parse(REAL_START);
  const now = () => new Date(realMs);
  const logs: Array<Record<string, unknown>> = [];
  const log = createLogger({ level: "debug", now, sink: (line) => void logs.push(JSON.parse(line) as Record<string, unknown>) });
  const memory = createMemoryConnector({ now });
  const data = memory.connector;
  const objects = flowObjects();
  const queue = localQueue();
  const network = localNetwork(memory.client, now);
  const guardrails = guardrailFake();
  const ses = sesFake(now);
  const knowledge = knowledgeFake();
  const transcribe = transcribeFake(objects);
  const social = recorder();
  const liveSocial = options.live === true ? fakeSocial(social, { ...objects.mediaStore, put: (key: string, bytes: Uint8Array, contentType: string) => objects.put("Media", key, bytes, contentType), keys: () => objects.keys("Media") }) : undefined;
  const stage = createStage({ memory, objects, queue, network, guardrails, ses, now, log, ...(liveSocial === undefined ? {} : { live: liveSocial }) });
  const targets = createTargets(stage, knowledge);
  const gateway = createLocalGateway(targets, { policies: localPolicies({ killSwitchActive: options.cedarKillSwitch ?? false }) });
  const harness = createScriptedHarness({ gateway, plans: options.agent ?? defaultAgent });
  const worker = createLocalWorker(stage, targets, options.harness?.(gateway) ?? { send: (input) => harness.send(input) }, transcribe);
  const base = memoryWorlds({ ...memory, now }, { queue: stage.sink, phoneHash: stage.hashPhone });
  const certificates = historicalCertificates({ connector: data, objects: { putPdf: async (key, bytes) => objects.put("Evidence", key, bytes, "application/pdf") }, photo: async (photoId) => photoBytes(photoId), brand: () => ({ mode: "neutral" }), logger: log });
  const worlds: WorldsDeps = {
    ...base.deps,
    scheduler: stage.scheduler,
    dispatcher: stage.dispatcher,
    runtimeSessionKey: stage.key("runtime-session"),
    nonces: { runtime: data.runtime, nonceKey: stage.key("nonce"), realClock: stage.realClock },
    media: objects.seedCopier,
    certificates,
    log,
  };
  await data.seed.loadItems("Reference", await referenceRows());
  await createDemoWorld(worlds);
  await buildWorld({ connector: data, client: memory.client, template: async () => TEMPLATE_TEXT, brand: () => ({ mode: "neutral" }), phoneHash: stage.hashPhone, now, certificates }, { ispId: GUEST_TEST_ISP, origin: "TEST" });
  const dispatch = localDispatch(memory.client.dump("Dispatch") as never, () => ({ connector: data, queue: stage.sink, logger: log }), now);

  async function settle(): Promise<void> {
    for (let round = 0; round < 50; round += 1) {
      await queue.drain((event) => worker.run(event));
      const events = ses.events();
      if (events.length === 0 && queue.pending() === 0) return;
      for (const event of events) await processEmailEvent(event, { connector: data, queue: stage.sink, configurationSetName: LOCAL_EMAIL_CONFIG.configurationSetName, logger: log });
    }
    throw new Error("the world did not settle");
  }

  const simNow = async (clockId: string = DEMO_CLOCK_ID) => (await stage.simNow(clockId)).toISOString();

  async function advance(target: ClockTarget, clockId: string = DEMO_CLOCK_ID): Promise<ClockMoved> {
    const moved = await advanceClock({ clockId, target, caller: { actor: "QA" } }, { data, scheduler: stage.scheduler, dispatcher: stage.dispatcher, realClock: stage.realClock, log });
    await settle();
    return moved;
  }

  async function deliver(clockId: string, phone: string, content: SimulatedContent): Promise<Sent> {
    realMs += PHONE_PAUSE_MS;
    const wamid = simulatorWamid(stage.newId());
    const event = buildSimulatedEvent({ clockId: clockId as ClockId, from: phone, wamid, content, sentAtReal: now() }, stage.key("sim-envelope"));
    const result = await processInboundEvent(event, stage.inbound);
    await settle();
    return { wamid, result };
  }

  async function phoneOf(personId: string): Promise<{ readonly phone: string; readonly clockId: string }> {
    const person = await data.people.getPerson(personId);
    if (person?.phone === undefined) throw new Error(`${personId} has no phone in this world`);
    return { phone: person.phone, clockId: person.clockId };
  }

  async function send(personId: string, content: SimulatedContent, clockId?: string): Promise<Sent> {
    const sender = await phoneOf(personId);
    return deliver(clockId ?? sender.clockId, sender.phone, content);
  }

  /** An upload of the simulator: the `UPLOAD#` row and the object at the world's key. */
  async function upload(personId: string, kind: "VOICE" | "PHOTO", bytes: Uint8Array, mime: string): Promise<{ readonly uploadId: string; readonly clockId: string }> {
    const { clockId } = await phoneOf(personId);
    const uploadId = `up${stage.newId()}`;
    const key = simMediaKey(clockId, await data.runtime.currentEpoch(clockId), uploadId);
    await data.worlds.createUpload({ uploadId, userId: UPLOADER, clockId, key, kind, maxBytes: 16 * 1024 * 1024 });
    objects.put("Media", key, bytes, mime);
    return { uploadId, clockId };
  }

  async function thread(personId: string): Promise<Message[]> {
    // Same simulated instant: what the person sent comes before what answered it.
    const rank = (message: Message) => (message.direction === "IN" ? 0 : 1);
    return (await data.conversations.listMessages(personId)).sort((a, b) => Date.parse(a.sentAtSim) - Date.parse(b.sentAtSim) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : rank(a) - rank(b)));
  }

  return {
    memory,
    data,
    stage,
    targets,
    gateway,
    harness,
    worker,
    worlds,
    objects,
    queue,
    network,
    dispatch,
    guardrails,
    ses,
    knowledge,
    transcribe,
    social,
    logs,
    clockId: DEMO_CLOCK_ID,
    ispId: DEMO_ISP_ID,
    realNow: now,
    advanceReal(ms) {
      realMs += ms;
    },
    simNow,
    advance,
    async at(time, clockId = DEMO_CLOCK_ID) {
      const day = (await simNow(clockId)).slice(0, 10);
      return advance({ to: new Date(`${day}T${time}:00-06:00`).toISOString() }, clockId);
    },
    settle,
    async preset(workOrderId, raw) {
      const order = await data.workOrders.requireWorkOrder(workOrderId);
      const installer = await data.people.requirePerson(order.installerId);
      const deps = { connector: data, client: memory.client, photos: PHOTO_INDEX, nonces: worlds.nonces, effects: casePresetEffects(stage.cases), media: objects.seedCopier, now };
      const applied = await applyOrderPreset(deps, new RenderAllocator(PHOTO_INDEX), { order, installer, atSim: await simNow(order.clockId) }, OrderPreset.parse(raw));
      await settle();
      return applied;
    },
    plan(...plans) {
      harness.next.push(...plans);
    },
    send,
    sendFrom: (phone, content, clockId = DEMO_CLOCK_ID) => deliver(clockId, phone, content),
    async sendLive(phone, body) {
      realMs += PHONE_PAUSE_MS;
      const wamid = `wamid.LIVE.${stage.newId()}`;
      const result = await processInboundEvent(liveEvent({ messages: [{ ...waText(phone, wamid, body), timestamp: String(Math.floor(realMs / 1_000)) }], messageId: `live-${stage.newId()}` }), stage.inbound);
      await settle();
      return { wamid, result };
    },
    text: (personId, body, clockId) => send(personId, { type: "text", body }, clockId),
    async voice(personId, voiceId, clockId) {
      const uploaded = await upload(personId, "VOICE", voiceBytes(voiceId), "audio/ogg");
      return send(personId, { type: "voice", uploadId: uploaded.uploadId, mimeType: "audio/ogg" }, clockId);
    },
    async photo(personId, photo, clockId) {
      const bytes = typeof photo === "string" ? photoBytes(photo) : photo.bytes;
      const mime = typeof photo === "string" ? "image/jpeg" : (photo.mime ?? "image/jpeg");
      const uploaded = await upload(personId, "PHOTO", bytes, mime);
      return send(personId, { type: "photo", uploadId: uploaded.uploadId, mimeType: mime }, clockId);
    },
    async tap(personId, button, clockId) {
      const title = typeof button === "string" ? buttonText(button, "es") : button.title;
      const offers = (await thread(personId)).filter((message) => message.direction === "OUT").reverse();
      for (const message of offers) {
        const found = buttonsOfMessage(message).find((candidate) => (typeof button === "string" ? candidate.title === title : candidate.title.includes(title) || (candidate.description ?? "").includes(title)));
        if (found === undefined) continue;
        const content: SimulatedContent = found.kind === "button" ? { type: "button", payload: found.id, text: found.title } : { type: found.kind, id: found.id, title: found.title };
        return send(personId, content, clockId);
      }
      throw new Error(`no message to ${personId} offers "${title}"`);
    },
    thread,
    async delivered(personId, kind) {
      const reached = new Set(["SENT", "DELIVERED", "READ"]);
      return (await thread(personId)).filter((message) => message.direction === "OUT" && reached.has(message.status) && Date.parse(message.sentAtSim) >= Date.parse(DEMO_DAY_START) && (kind === undefined || message.kind === kind));
    },
    async decisions(ispId = DEMO_ISP_ID) {
      return (await data.audit.listByMonth(ispId, "2026-10")).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    },
    async outbound(personId, kind) {
      return (await thread(personId)).filter((message) => message.direction === "OUT" && Date.parse(message.sentAtSim) >= Date.parse(DEMO_DAY_START) && (kind === undefined || message.kind === kind));
    },
  };
}
