// One inbound WhatsApp event, live or simulated, end to end (docs/architecture-integrations.md §4.4 and
// §4.6; docs/design-brief.md §5.1). `handlers/inbound-whatsapp.ts` is the thin Lambda entry that wires
// the production ports and calls `processInboundEvent`; the phone simulator reaches the same code with
// the signed envelope, so a live message and a simulated one with the same content end the same way.
//
//   1-3  origin and number (phone-filter.ts): a foreign event leaves a probe and a metric, nothing else
//   4    world and person (identity.ts); a live message stamps `lastInboundAtReal` (events.ts)
//   5    idempotency by `wamid` in the world, then "ALTA <código>" from a real phone (gate.ts)
//        unknown number → at most the fixed reply, never the agent (gate.ts)
//        ALTA / BAJA (no opt-in needed) → keywords.ts; no opt-in → fixed reply, no turn
//        over the messages per hour of the identity (channels/rate-limit.ts) → DENY RATE_LIMIT, nothing else
//        a button → its nonce (nonces.ts); a voice note or a photo → its media (media.ts)
//        the `Message IN` (masked) and `lastInboundAtSim`: every inbound, a tap too, opens the window
//        TURNO / ÓRDENES / a button → keywords.ts; a supervisor's message → routing.ts
//        an installer's message → `INBOUND_MESSAGE` on the installer's queue, then the read receipt
import type { Connector } from "../../connector/ports";
import type { Message, MessageContent, MessageMedia } from "../../domain/conversations";
import { parseKeyword } from "../../copy/keywords";
import { esMX } from "../../copy/es-MX";
import { type Clock, systemClock } from "../../lib/clock";
import type { SecretKey } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import type { KillSwitchReader } from "../../ops/kill-switch";
import { normalizeUntrusted } from "../normalizer";
import { RATE_LIMIT_RULE, admitMessage } from "../rate-limit";
import { acknowledgeInbound } from "./ack";
import type { SocialMessagingPort } from "./client";
import { type StaffDeps, type StaffMessage, messageRefOf, noticeTo } from "./context";
import { type StatusDeps, type StatusOutcome, applyStatuses, recordLiveInbound } from "./events";
import { answerUnknownSender, bindFromLivePhone, consentState, refuseWithoutConsent } from "./gate";
import { type SenderIdentity, allowlistedPerson, resolveSender } from "./identity";
import { INSTALLER_BUTTONS, SUPERVISOR_BUTTONS, handleButton, handleKeyword, isQueuedOutcome, worksWithoutConsent } from "./keywords";
import { type MediaDeps, type InboundContent, contentOf, fetchInboundMedia } from "./media";
import { type NonceResolution, auditNonceDenial, resolveNonce } from "./nonces";
import { type PhoneFilterDeps, type ScreenResult, recordForeign, screenRecord } from "./phone-filter";
import { type ChannelActions, type EventQueue, type MetricSink, type NoticeSender, type WorldTime, type WorldTimeReader, inboundEventId } from "./ports";
import { type InboundMessage as InboundMessageType, SnsEvent } from "./payloads";
import { routeSupervisorMessage } from "./routing";

export interface InboundDeps {
  readonly connector: Connector;
  readonly filter: PhoneFilterDeps;
  readonly phoneHashKey: SecretKey;
  readonly nonceKey: SecretKey;
  readonly worldTime: WorldTimeReader;
  readonly kill: KillSwitchReader;
  readonly notices: NoticeSender;
  readonly queue: EventQueue;
  readonly actions: ChannelActions;
  readonly media: MediaDeps;
  /** End User Messaging Social; live only (receipts). */
  readonly social?: SocialMessagingPort;
  readonly fallback: StatusDeps["fallback"];
  readonly metrics: MetricSink;
  readonly logger: Logger;
  readonly realClock?: Clock;
}

export type MessageOutcome =
  | "DUPLICATE"
  | "LEASE_BOUND"
  | "LEASE_REFUSED"
  | "UNKNOWN_SENDER"
  | "KEYWORD"
  | "NO_CONSENT"
  | "BUTTON"
  | "BUTTON_REFUSED"
  | "SUPERVISOR"
  | "MEDIA_REFUSED"
  | "UNSUPPORTED"
  | "RATE_LIMITED"
  | "QUEUED"
  /** A dependency failed while processing it; logged, and the event is returned to SNS for a retry. */
  | "FAILED";

export interface RecordOutcome {
  readonly verdict: ScreenResult["verdict"];
  readonly reason?: string;
  readonly messages: readonly MessageOutcome[];
  readonly statuses: readonly StatusOutcome[];
}

export interface InboundResult {
  readonly records: readonly RecordOutcome[];
  /**
   * A dependency failed on a record that may be ours: the handler throws so SNS retries it. A message
   * already processed is then a `DUPLICATE` (idempotency by `wamid`), so a retry never repeats effects.
   */
  readonly retry: boolean;
}

const CONTENT: Readonly<Record<InboundContent["kind"], MessageContent>> = { TEXT: "TEXT", BUTTON: "BUTTON", VOICE: "VOICE", IMAGE: "IMAGE", UNSUPPORTED: "OTHER" };

function messageContent(raw: InboundMessageType, content: InboundContent): MessageContent {
  if (content.kind === "BUTTON") return raw.type === "interactive" ? "INTERACTIVE" : "BUTTON";
  if (content.kind === "UNSUPPORTED") return raw.type === "sticker" ? "STICKER" : raw.type === "document" ? "DOCUMENT" : "OTHER";
  return CONTENT[content.kind];
}

/** What the person wrote, cleaned, masked and clipped before it is stored (channels/normalizer.ts). */
function maskedText(content: InboundContent): string | undefined {
  const text = content.kind === "TEXT" ? content.text : content.kind === "BUTTON" ? content.title : content.kind === "IMAGE" ? content.caption : undefined;
  return text === undefined ? undefined : normalizeUntrusted(text).text;
}

interface Incoming {
  readonly origin: "LIVE" | "SIMULATED";
  readonly raw: InboundMessageType;
  readonly content: InboundContent;
  readonly sender: SenderIdentity;
  readonly clockId: string;
  readonly world: WorldTime;
}

async function storeMessage(incoming: Incoming, person: StaffMessage["person"], extra: { readonly media?: MessageMedia; readonly nonce?: NonceResolution }, deps: InboundDeps): Promise<StaffMessage> {
  const { raw, content, sender, clockId, world } = incoming;
  const atReal = (await (deps.realClock ?? systemClock).now()).toISOString();
  const nonce = extra.nonce?.ok === true ? extra.nonce.nonce : undefined;
  const active = person.role === "INSTALLER" ? (await deps.connector.worlds.getInstallerState(person.personId))?.activeWorkOrderId : undefined;
  const workOrderId = nonce?.object.kind === "WORK_ORDER" ? nonce.object.id : active;
  const text = maskedText(content);
  const message: Message = await deps.connector.conversations.appendMessage({
    messageId: raw.id,
    personId: person.personId,
    ispId: person.ispId,
    clockId,
    direction: "IN",
    channel: "WHATSAPP",
    content: messageContent(raw, content),
    status: "RECEIVED",
    author: `PERSON:${person.personId}`,
    simulated: incoming.origin === "SIMULATED",
    transport: sender.transport,
    providerMessageId: raw.id,
    sentAtSim: world.simNow.toISOString(),
    sentAtReal: atReal,
    ...(text === undefined ? {} : { text }),
    ...(workOrderId === undefined ? {} : { workOrderId }),
    ...(extra.media === undefined ? {} : { media: extra.media }),
    ...(nonce === undefined ? {} : { nonce: nonce.nonce, buttonAction: nonce.action, refs: { buttonObject: { ...nonce.object } } }),
  });
  await deps.connector.people.recordInbound(person.personId, { atSim: world.simNow.toISOString() });
  return { sender, clockId, ispId: person.ispId, person, wamid: raw.id, message, eventId: inboundEventId(clockId, raw.id), simNow: world.simNow, timeZone: world.timeZone };
}

function staffDeps(deps: InboundDeps): StaffDeps {
  return { connector: deps.connector, actions: deps.actions, notices: deps.notices, queue: deps.queue, nonces: { runtime: deps.connector.runtime, nonceKey: deps.nonceKey, realClock: deps.realClock ?? systemClock }, logger: deps.logger };
}

async function acknowledge(staff: StaffMessage, deps: InboundDeps): Promise<void> {
  const kill = await deps.kill.status(staff.clockId);
  await acknowledgeInbound({ message: staff.message, transport: staff.sender.transport, kill }, { conversations: deps.connector.conversations, logger: deps.logger, ...(deps.social === undefined ? {} : { social: deps.social }), ...(deps.realClock === undefined ? {} : { realClock: deps.realClock }) });
}

/** Messages per identity and hour (channels/rate-limit.ts): over the limit, `DENY RATE_LIMIT` and nothing else. */
async function withinRateLimit(incoming: Incoming, person: StaffMessage["person"], deps: InboundDeps): Promise<boolean> {
  const realNow = await (deps.realClock ?? systemClock).now();
  const settings = await deps.connector.isps.getSettings(person.ispId);
  const admission = await admitMessage(deps.connector.runtime, { clockId: incoming.clockId, addressHash: incoming.sender.phoneHash, simNow: incoming.world.simNow, realNow, settings });
  if (admission.ok) return true;
  await deps.connector.audit.append({
    ispId: person.ispId,
    clockId: incoming.clockId,
    atSim: incoming.world.simNow.toISOString(),
    decision: "DENY",
    action: "INBOUND_MESSAGE",
    actor: "CHANNEL",
    reason: RATE_LIMIT_RULE,
    messageId: incoming.raw.id,
    refs: { personId: person.personId },
    detail: { window: admission.window, limit: admission.limit, resetsAt: admission.resetsAt },
  });
  return false;
}

/** From the person onwards: opt-in, keywords, buttons, media and the queue. */
async function processStaffMessage(incoming: Incoming, person: StaffMessage["person"], deps: InboundDeps): Promise<MessageOutcome> {
  const { content } = incoming;
  const staffPorts = staffDeps(deps);
  const keyword = content.kind === "TEXT" ? parseKeyword(content.text) : null;
  const consent = await consentState(person.personId, deps.connector);
  if (keyword !== null && worksWithoutConsent(keyword)) {
    await handleKeyword(keyword, await storeMessage(incoming, person, {}, deps), consent === "GRANTED", staffPorts);
    return "KEYWORD";
  }
  if (consent !== "GRANTED") {
    await refuseWithoutConsent(await storeMessage(incoming, person, {}, deps), consent, staffPorts);
    return "NO_CONSENT";
  }
  if (!(await withinRateLimit(incoming, person, deps))) return "RATE_LIMITED";
  const isSupervisor = person.role === "SUPERVISOR";
  const nonce =
    content.kind === "BUTTON"
      ? await resolveNonce({ payload: content.payload, clockId: incoming.clockId, phoneHash: incoming.sender.phoneHash, allowedActions: isSupervisor ? SUPERVISOR_BUTTONS : INSTALLER_BUTTONS }, staffPorts.nonces)
      : undefined;
  const refuse = async (notice: "unsupportedMedia" | "imageTooLarge" | "imageUnreadable" | "voiceTooLong" | "voiceFailed", outcome: MessageOutcome): Promise<MessageOutcome> => {
    await deps.notices.send(noticeTo(await storeMessage(incoming, person, {}, deps), notice, esMX[notice]));
    return outcome;
  };
  if (content.kind === "UNSUPPORTED" || (content.kind === "VOICE" && isSupervisor)) return refuse("unsupportedMedia", "UNSUPPORTED");
  let media: MessageMedia | undefined;
  if (content.kind === "VOICE" || content.kind === "IMAGE") {
    const fetched = await fetchInboundMedia({ origin: incoming.origin, clockId: incoming.clockId, worldEpoch: incoming.world.worldEpoch, wamid: incoming.raw.id, content }, deps.media);
    if (!fetched.ok) return refuse(fetched.notice, "MEDIA_REFUSED");
    media = fetched.media;
  }
  const staff = await storeMessage(incoming, person, { ...(media === undefined ? {} : { media }), ...(nonce === undefined ? {} : { nonce }) }, deps);
  if (keyword !== null) {
    const handled = await handleKeyword(keyword, staff, true, staffPorts);
    if (handled === "ORDERS_REQUESTED") await acknowledge(staff, deps);
    if (handled !== undefined) return "KEYWORD";
  }
  if (nonce !== undefined) {
    if (!nonce.ok) {
      await auditNonceDenial(deps.connector.audit, { ispId: staff.ispId, clockId: staff.clockId, atSim: staff.simNow.toISOString(), personId: person.personId, reason: nonce.reason, messageId: staff.wamid });
      await deps.notices.send(noticeTo(staff, "buttonExpired", esMX.buttonExpired));
      return "BUTTON_REFUSED";
    }
    const outcome = await handleButton(nonce.nonce, staff, staffPorts);
    if (outcome === "OBJECT_GONE") await deps.notices.send(noticeTo(staff, "buttonExpired", esMX.buttonExpired));
    if (isQueuedOutcome(outcome)) await acknowledge(staff, deps);
    return "BUTTON";
  }
  if (isSupervisor) {
    await routeSupervisorMessage(staff, staffPorts);
    return "SUPERVISOR";
  }
  await deps.queue.enqueue({ type: "INBOUND_MESSAGE", eventId: staff.eventId, clockId: staff.clockId, ispId: staff.ispId, installerId: person.personId, message: messageRefOf(staff.message) });
  await acknowledge(staff, deps);
  return "QUEUED";
}

async function processMessage(origin: "LIVE" | "SIMULATED", envelopeClockId: string | undefined, raw: InboundMessageType, deps: InboundDeps): Promise<MessageOutcome> {
  const { connector } = deps;
  const sender = await resolveSender({ origin, waId: raw.from, ...(envelopeClockId === undefined ? {} : { clockId: envelopeClockId }) }, { people: connector.people, worlds: connector.worlds, phoneHashKey: deps.phoneHashKey });
  if (origin === "LIVE") await recordLiveInbound(sender, raw.timestamp, connector);
  if (!(await connector.runtime.claimIdempotency("wa-inbound", `${sender.clockId ?? "no-world"}#${raw.id}`))) return "DUPLICATE";
  const world = sender.clockId === undefined ? undefined : await deps.worldTime(sender.clockId);
  const content = contentOf(raw);
  const keyword = content.kind === "TEXT" ? parseKeyword(content.text) : null;
  const gate = { connector, notices: deps.notices, metrics: deps.metrics, ...(deps.realClock === undefined ? {} : { realClock: deps.realClock }) };
  if (origin === "LIVE" && keyword?.kind === "ALTA_CODE") {
    const leaseDeps = { worlds: connector.worlds, people: connector.people, audit: connector.audit };
    return (await bindFromLivePhone(sender, world, keyword.code, raw.id, { ...gate, leases: leaseDeps })) === "BOUND" ? "LEASE_BOUND" : "LEASE_REFUSED";
  }
  const person = allowlistedPerson(sender);
  if (person === undefined || world === undefined || sender.clockId === undefined) {
    await answerUnknownSender(sender, world, raw.id, gate);
    return "UNKNOWN_SENDER";
  }
  return processStaffMessage({ origin, raw, content, sender, clockId: sender.clockId, world }, person, deps);
}

async function processAccepted(screened: Extract<ScreenResult, { verdict: "ACCEPT" }>, deps: InboundDeps): Promise<RecordOutcome> {
  const messages: MessageOutcome[] = [];
  const statuses: StatusOutcome[] = [];
  const clockId = screened.origin === "SIMULATED" ? screened.clockId : undefined;
  for (const change of screened.entry.changes) {
    if (screened.origin === "LIVE" && change.value.statuses !== undefined) {
      statuses.push(...(await applyStatuses(change.value.statuses, { conversations: deps.connector.conversations, runtime: deps.connector.runtime, audit: deps.connector.audit, metrics: deps.metrics, fallback: deps.fallback, logger: deps.logger })));
    }
    for (const raw of change.value.messages ?? []) {
      try {
        messages.push(await processMessage(screened.origin, clockId, raw, deps));
      } catch (error) {
        deps.logger.error("inbound WhatsApp message failed", { eventId: screened.snsMessageId, messageId: raw.id, error });
        messages.push("FAILED");
      }
    }
  }
  return { verdict: "ACCEPT", messages, statuses };
}

/** Every record of the Lambda event (a live SNS delivery or the simulator's signed envelope). */
export async function processInboundEvent(event: unknown, deps: InboundDeps): Promise<InboundResult> {
  const parsed = SnsEvent.safeParse(event);
  if (!parsed.success) {
    deps.logger.warn("inbound WhatsApp event is not an SNS event");
    return { records: [], retry: false };
  }
  const records: RecordOutcome[] = [];
  let retry = false;
  for (const record of parsed.data.Records) {
    const screened = await screenRecord(record, deps.filter);
    if (screened.verdict === "ACCEPT") {
      const outcome = await processAccepted(screened, deps);
      retry ||= outcome.messages.includes("FAILED");
      records.push(outcome);
      continue;
    }
    if (screened.verdict === "FOREIGN") await recordForeign(screened, { worlds: deps.connector.worlds, metrics: deps.metrics, logger: deps.logger });
    else deps.logger.info("inbound WhatsApp record discarded", { verdict: screened.verdict, reason: screened.reason });
    retry ||= screened.verdict === "RETRY";
    records.push({ verdict: screened.verdict, reason: screened.reason, messages: [], statuses: [] });
  }
  return { records, retry };
}
