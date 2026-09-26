// Test support for the WhatsApp adapter's own tests (never imported by runtime code). Fixtures have
// the real shape of End User Messaging Social (docs/architecture-integrations.md §4.2): an SNS record
// signed with SHA256withRSA (a key generated per run stands for SNS's certificate), `context` with the
// Meta id and the ARN of the AWS id, and `whatsAppWebhookEntry` as a JSON string. The two ids of the
// number always differ, as they do in reality. People and numbers are the synthetic ones of
// docs/seed-spec.md (demo block `+52 55 0101 …`, judge world 07 block `+52 55 0207 …`).
import { createSign, generateKeyPairSync } from "node:crypto";
import type { WaButtonAction, WhatsAppMode } from "@cuadrilla/shared";
import { testConnector } from "../../connector/testing";
import { simMediaKey } from "@cuadrilla/shared/media/keys";
import type { NonceObject } from "../../domain/runtime";
import type { Clock } from "../../lib/clock";
import { phoneHash } from "../../lib/crypto";
import { createLogger } from "../../lib/log";
import { createKillSwitchReader } from "../../ops/kill-switch";
import { createMemoryRuntimeStore } from "../../ops/memory-runtime-store";
import type { SocialMessagingPort } from "./client";
import { phoneNumberArn } from "./config";
import type { WindowFallbackPort } from "./events";
import type { InboundDeps } from "./inbound";
import type { MediaStore } from "./media-store";
import { issueNonce } from "./nonces";
import { type SimulatedContent, buildSimulatedEvent } from "./sim-envelope";
import { snsStringToSign, createSnsVerifier } from "./sns-signature";
import type { SnsNotification } from "./payloads";
import { type ChannelActions, type ChannelMetric, type ChannelQueueEvent, type NoticeRequest, type WorkOrderActions, connectorWorldTime, worldModeReader } from "./ports";

export const AWS_ID = "phone-number-id-0123456789abcdef0123456789abcdef";
export const META_ID = "106540352242922";
export const FOREIGN_META_ID = "109876543219876";
export const PHONE_KEY = new Uint8Array(32).fill(7);
export const SIM_KEY = new Uint8Array(32).fill(9);
export const NONCE_KEY = new Uint8Array(32).fill(5);
export const REAL_NOW = "2026-10-13T15:20:00.000Z";
export const SIM_START = "2026-10-13T07:00:00-06:00";

export const DEMO = "GLOBAL#isp-demo";
export const JUDGE = "JUDGE#isp-judge-07";

/** Staff of the two worlds: [personId, role, phone, consent]. */
export const PEOPLE = {
  rogelio: { personId: "inst-rogelio", clockId: DEMO, role: "INSTALLER", firstName: "Rogelio", phone: "+525501010001", consent: "GRANTED" },
  julian: { personId: "inst-julian", clockId: DEMO, role: "INSTALLER", firstName: "Julián", phone: "+525501010003", consent: undefined },
  ernesto: { personId: "inst-ernesto", clockId: DEMO, role: "INSTALLER", firstName: "Ernesto", phone: "+525501010006", consent: "REVOKED" },
  adriana: { personId: "sup-adriana", clockId: DEMO, role: "SUPERVISOR", firstName: "Adriana", phone: "+525501020001", consent: "GRANTED" },
  rogelioJ07: { personId: "inst-rogelio-j07", clockId: JUDGE, role: "INSTALLER", firstName: "Rogelio", phone: "+525502070001", consent: "GRANTED" },
  hectorJ07: { personId: "sup-hector-j07", clockId: JUDGE, role: "SUPERVISOR", firstName: "Héctor", phone: "+525502070102", consent: "GRANTED" },
} as const;
export type PersonKey = keyof typeof PEOPLE;

export const UNKNOWN_PHONE = "+525501990001";

export const hashOf = (phone: string): string => phoneHash(PHONE_KEY, phone);
export const waIdOf = (phone: string): string => phone.slice(1);

// ---- Live SNS fixtures --------------------------------------------------------------------------

const snsKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const SNS_PUBLIC_PEM = snsKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
export const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem";
export const TOPIC_ARN = "arn:aws:sns:us-east-1:776805327629:aws-cds-hackathon-poc-cuadrilla-wa-inbound";

export type UnsignedSns = Pick<SnsNotification, "Type" | "MessageId" | "TopicArn" | "Message" | "Timestamp" | "SignatureVersion"> &
  Partial<Pick<SnsNotification, "Subject" | "SigningCertUrl" | "SigningCertURL" | "MessageAttributes">>;

export function signSns(sns: UnsignedSns): SnsNotification {
  const canonical = snsStringToSign({ ...sns, Signature: "x" }) ?? "";
  return { ...sns, Signature: createSign("RSA-SHA256").update(canonical, "utf8").sign(snsKeys.privateKey, "base64") };
}

export const testVerifier = () => createSnsVerifier({ fetchCertificate: async () => SNS_PUBLIC_PEM });

export interface LiveRecordOptions {
  readonly messages?: readonly object[];
  readonly statuses?: readonly object[];
  /** Meta id in `context.MetaPhoneNumberIds` (ours by default). */
  readonly contextMetaId?: string;
  /** ARN in `context.MetaPhoneNumberIds` (ours by default). */
  readonly contextArn?: string;
  /** `metadata.phone_number_id` of the change (ours by default); `null` drops `metadata`. */
  readonly changeMetaId?: string | null;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly certUrl?: string;
  readonly messageId?: string;
  /** `TopicArn` of the notification (our topic by default). */
  readonly topicArn?: string;
}

export function liveRecord(options: LiveRecordOptions = {}): { EventSource: string; Sns: SnsNotification } {
  const changeMetaId = options.changeMetaId === undefined ? META_ID : options.changeMetaId;
  const value = {
    messaging_product: "whatsapp",
    ...(changeMetaId === null ? {} : { metadata: { display_phone_number: "15550000000", phone_number_id: changeMetaId } }),
    ...(options.messages === undefined ? {} : { messages: options.messages }),
    ...(options.statuses === undefined ? {} : { statuses: options.statuses }),
  };
  const body = {
    context: {
      MetaWabaIds: [{ wabaId: "209876543210987", arn: "arn:aws:social-messaging:us-east-1:776805327629:waba/0f1e2d3c4b5a69788796a5b4c3d2e1f0" }],
      MetaPhoneNumberIds: [{ metaPhoneNumberId: options.contextMetaId ?? META_ID, arn: options.contextArn ?? phoneNumberArn(AWS_ID) }],
    },
    whatsAppWebhookEntry: JSON.stringify({ id: "209876543210987", changes: [{ field: "messages", value }] }),
    aws_account_id: "776805327629",
    message_timestamp: REAL_NOW,
    messageId: "5f2c4f0e-8b1d-4c63-9d57-6b1f1b0a2c11",
  };
  const attributes = Object.fromEntries(Object.entries(options.attributes ?? {}).map(([name, value]) => [name, { Type: "String", Value: value }]));
  const sns = signSns({
    Type: "Notification",
    MessageId: options.messageId ?? "a1b2c3d4-0000-4000-8000-000000000001",
    TopicArn: options.topicArn ?? TOPIC_ARN,
    Subject: null,
    Message: JSON.stringify(body),
    Timestamp: REAL_NOW,
    SignatureVersion: "2",
    SigningCertUrl: options.certUrl ?? CERT_URL,
    ...(Object.keys(attributes).length === 0 ? {} : { MessageAttributes: attributes }),
  });
  return { EventSource: "aws:sns", Sns: sns };
}

const TS = String(Math.floor(Date.parse(REAL_NOW) / 1000));
const base = (phone: string, id: string) => ({ from: waIdOf(phone), id, timestamp: TS });

export const waText = (phone: string, id: string, body: string) => ({ ...base(phone, id), type: "text", text: { body } });
export const waButton = (phone: string, id: string, payload: string, text = "Botón") => ({ ...base(phone, id), type: "button", button: { payload, text } });
export const waReply = (phone: string, id: string, replyId: string, title = "Botón") => ({ ...base(phone, id), type: "interactive", interactive: { type: "button_reply", button_reply: { id: replyId, title } } });
export const waAudio = (phone: string, id: string, mediaId = "1123581321345589") => ({ ...base(phone, id), type: "audio", audio: { id: mediaId, mime_type: "audio/ogg; codecs=opus", voice: true } });
export const waImage = (phone: string, id: string, mediaId = "2233445566778899", caption?: string) => ({ ...base(phone, id), type: "image", image: { id: mediaId, mime_type: "image/jpeg", ...(caption === undefined ? {} : { caption }) } });
export const waOther = (phone: string, id: string, type: string) => ({ ...base(phone, id), type });
export const liveEvent = (options: LiveRecordOptions = {}) => ({ Records: [liveRecord(options)] });

// ---- Worlds, people and ports -------------------------------------------------------------------

export async function seedWorlds(world: ReturnType<typeof testConnector>, liveWorld: boolean = true): Promise<void> {
  const { connector } = world;
  const worlds: ReadonlyArray<readonly [string, string, "DEMO" | "JUDGE", WhatsAppMode]> = [
    [DEMO, "isp-demo", "DEMO", liveWorld ? "live" : "simulated"],
    [JUDGE, "isp-judge-07", "JUDGE", "simulated"],
  ];
  for (const [clockId, ispId, kind, whatsappMode] of worlds) {
    await connector.runtime.createClock({ clockId, ispId, kind, mode: "PAUSED", offsetMs: 0, pausedSimNow: SIM_START, worldEpoch: 3 });
    await connector.isps.putSettings({
      ispId,
      clockId,
      quietHours: { start: "21:00", end: "07:00" },
      caseTimeoutSec: 600,
      demoMode: false,
      demoCaseTimeoutSec: 60,
      whatsappMode,
      turnCaps: { perHour: 200, perDay: 1000 },
      simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 60 },
    });
  }
  if (liveWorld) await connector.worlds.setLiveWorld(DEMO, "OPERATOR");
  for (const person of Object.values(PEOPLE)) {
    const ispId = person.clockId === DEMO ? "isp-demo" : "isp-judge-07";
    await connector.people.createPerson({ personId: person.personId, ispId, clockId: person.clockId, role: person.role, firstName: person.firstName, lastName: "Ficticio", phone: person.phone, phoneHash: hashOf(person.phone), active: true });
    if (person.consent === undefined) continue;
    await connector.people.grantConsent({ personId: person.personId, clockId: person.clockId, medium: "SEED", textVersion: "v001" }, { actor: "SEED", atSim: SIM_START });
    if (person.consent === "REVOKED") await connector.people.revokeConsent(person.personId, { actor: "SEED", atSim: SIM_START });
  }
}

export interface Recorded {
  readonly notices: NoticeRequest[];
  readonly queued: ChannelQueueEvent[];
  readonly actions: Array<{ readonly name: keyof ChannelActions | keyof WorkOrderActions; readonly input: Record<string, unknown> }>;
  readonly metrics: Array<{ readonly metric: ChannelMetric; readonly dimensions: Readonly<Record<string, string>> }>;
  readonly sent: unknown[];
  readonly media: Array<{ readonly op: string; readonly mediaId?: string; readonly key?: string }>;
  readonly fallbacks: Array<{ readonly messageId: string; readonly template?: string }>;
}

export function recorder(): Recorded {
  return { notices: [], queued: [], actions: [], metrics: [], sent: [], media: [], fallbacks: [] };
}

/** A media store over memory: `put` stands for what EUM Social or the simulator wrote to S3. */
export function memoryMediaStore(): MediaStore & { put(key: string, bytes: Uint8Array, contentType: string): void; keys(): string[] } {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    put: (key, bytes, contentType) => void objects.set(key, { bytes, contentType }),
    keys: () => [...objects.keys()],
    head: async ({ key }) => {
      const object = objects.get(key);
      return object === undefined ? undefined : { bytes: object.bytes.length, contentType: object.contentType };
    },
    readStart: async ({ key }, count) => objects.get(key)?.bytes.slice(0, count) ?? new Uint8Array(),
    delete: async ({ key }) => void objects.delete(key),
  };
}

export const JPEG = (size = 2048): Uint8Array => Uint8Array.from({ length: size }, (_, index) => [0xff, 0xd8, 0xff, 0xe0][index] ?? 0x20);
export const OGG = (size = 2048): Uint8Array => Uint8Array.from({ length: size }, (_, index) => [0x4f, 0x67, 0x67, 0x53][index] ?? 0x00);

export interface FakeMedia {
  readonly mimeType: string;
  readonly fileSize: number;
  readonly bytes?: Uint8Array;
}

/** What Meta holds for a media id: the fixture image id is a JPEG, anything else an Ogg voice note. */
const defaultMedia = (mediaId: string): FakeMedia => (mediaId.startsWith("22") ? { mimeType: "image/jpeg", fileSize: 4096 } : { mimeType: "audio/ogg", fileSize: 2048 });

/** EUM Social stand-in: records every call; media downloads land in `store`. */
export function fakeSocial(rec: Recorded, store: ReturnType<typeof memoryMediaStore>, fixed?: FakeMedia): SocialMessagingPort {
  let counter = 0;
  const mediaFor = (mediaId: string): FakeMedia => fixed ?? defaultMedia(mediaId);
  return {
    send: async (payload) => {
      rec.sent.push(payload);
      counter += 1;
      return { messageId: `wamid.OUT${counter}` };
    },
    mediaMetadata: async (mediaId) => {
      rec.media.push({ op: "metadata", mediaId });
      const media = mediaFor(mediaId);
      return { mimeType: media.mimeType, fileSize: media.fileSize };
    },
    downloadMedia: async (mediaId, destination) => {
      rec.media.push({ op: "download", mediaId, key: destination.key });
      const media = mediaFor(mediaId);
      store.put(destination.key, media.bytes ?? (media.mimeType.startsWith("image") ? JPEG(media.fileSize) : OGG(media.fileSize)), media.mimeType);
      return { mimeType: media.mimeType, fileSize: media.fileSize };
    },
    uploadMedia: async (source) => {
      rec.media.push({ op: "upload", key: source.key });
      return { mediaId: `meta-media-${rec.media.length}` };
    },
  };
}

export function recordingActions(rec: Recorded, overrides: Partial<ChannelActions> = {}): ChannelActions {
  const record = (name: keyof ChannelActions) => (input: object) => void rec.actions.push({ name, input: { ...input } });
  return {
    recordConsent: async (input) => record("recordConsent")(input),
    revokeConsent: async (input) => record("revokeConsent")(input),
    registerShift: async (input) => {
      record("registerShift")(input);
      return { closesAtSim: "2026-10-14T07:00:00-06:00" };
    },
    ...overrides,
  };
}

/** The worker's handlers of a `BUTTON_ACTION`, recording what they were asked. */
export function recordingWorkOrderActions(rec: Recorded, overrides: Partial<WorkOrderActions> = {}): WorkOrderActions {
  const record = (name: keyof WorkOrderActions) => (input: object) => void rec.actions.push({ name, input: { ...input } });
  return {
    openConsultCase: async (input) => record("openConsultCase")(input),
    closeInstallation: async (input) => {
      record("closeInstallation")(input);
      return { ok: true };
    },
    recordCustomerOk: async (input) => record("recordCustomerOk")(input),
    ...overrides,
  };
}

export function fakeFallback(rec: Recorded): WindowFallbackPort {
  return {
    sendTemplate: async (original, template) => void rec.fallbacks.push({ messageId: original.messageId, template }),
    holdForNextInbound: async (original) => void rec.fallbacks.push({ messageId: original.messageId }),
  };
}

export const quietLogger = () => createLogger({ level: "error", sink: () => undefined });

export interface Harness {
  readonly world: ReturnType<typeof testConnector>;
  readonly rec: Recorded;
  readonly store: ReturnType<typeof memoryMediaStore>;
  readonly kill: ReturnType<typeof createMemoryRuntimeStore>;
  readonly deps: InboundDeps;
}

/** Everything `processInboundEvent` needs, over memory, with every port recording what it was asked. */
export async function inboundHarness(options: { liveTransport?: boolean; liveWorld?: boolean; actions?: Partial<ChannelActions>; media?: FakeMedia } = {}): Promise<Harness> {
  const world = testConnector(REAL_NOW);
  await seedWorlds(world, options.liveWorld ?? true);
  const rec = recorder();
  const store = memoryMediaStore();
  const kill = createMemoryRuntimeStore();
  const realClock: Clock = { now: async () => world.now() };
  const social = fakeSocial(rec, store, options.media);
  const { connector } = world;
  const deps: InboundDeps = {
    connector,
    filter: {
      verifier: testVerifier(),
      topicArn: () => TOPIC_ARN,
      simEnvelopeKey: SIM_KEY,
      numberIds: () => ({ phoneNumberId: AWS_ID, metaPhoneNumberId: META_ID }),
      stageTransports: () => (options.liveTransport ?? true ? ["simulated", "live"] : ["simulated"]),
      worldMode: worldModeReader(connector),
    },
    phoneHashKey: PHONE_KEY,
    nonceKey: NONCE_KEY,
    worldTime: connectorWorldTime(connector, realClock),
    kill: createKillSwitchReader({ store: kill, realClock, ttlMs: 0 }),
    notices: { send: async (request) => void rec.notices.push(request) },
    queue: { enqueue: async (event) => void rec.queued.push(event) },
    actions: recordingActions(rec, options.actions),
    media: { store, mediaBucket: () => "poc-media", social, worlds: connector.worlds },
    social,
    fallback: fakeFallback(rec),
    metrics: { count: (metric, dimensions = {}) => void rec.metrics.push({ metric, dimensions }) },
    logger: quietLogger(),
    realClock,
  };
  return { world, rec, store, kill, deps };
}

/** The simulator's signed envelope for a person of a world. */
export function simEvent(clockId: string, phone: string, wamid: string, content: SimulatedContent) {
  return buildSimulatedEvent({ clockId, from: phone, wamid, content, sentAtReal: new Date(REAL_NOW) }, SIM_KEY);
}

/** A button the product sent to a person of the fixtures. */
export function nonceFor(h: Harness, key: PersonKey, action: WaButtonAction, object: NonceObject, messageId?: string): Promise<string> {
  const person = PEOPLE[key];
  const input = { clockId: person.clockId, personId: person.personId, phoneHash: hashOf(person.phone), action, object, ...(messageId === undefined ? {} : { messageId }) };
  return issueNonce(input, { runtime: h.world.connector.runtime, nonceKey: NONCE_KEY, realClock: { now: async () => h.world.now() } });
}

/** A simulator upload of the judge world (epoch 3): the `UPLOAD#` row and the object at its key. */
export async function simUpload(h: Harness, uploadId: string, kind: "VOICE" | "PHOTO", bytes: Uint8Array, contentType: string): Promise<string> {
  const key = simMediaKey(JUDGE, 3, uploadId);
  await h.world.connector.worlds.createUpload({ uploadId, userId: "usr-judge-07", clockId: JUDGE, key, kind, maxBytes: 3_670_016 });
  h.store.put(key, bytes, contentType);
  return key;
}
