// The user message of a turn (docs/design-brief.md §5.2): an envelope written by code, never free text
// from the edge.
//
//   <session token="…" delim="inbound-5c1e0a"/>                 signed token of the turn and the name of its untrusted block
//   <event type="INSTALLER_MESSAGE" id="evt_…" at="…-06:00" workOrder="24817"/>
//   <facts>…</facts>                                              state of the order, one fact per line
//   <inbound-5c1e0a channel="WHATSAPP" kind="VOICE_TRANSCRIPT" confidence="0.93" truncated="false">…</inbound-5c1e0a>
//   <attachment kind="IMAGE" candidateId="…" bytes="412331"/>     a photo the installer sent (never the image)
//   <attachment kind="IMAGE" candidateId="…" item="ONU_LABEL_PHOTO"/>  an earlier photo whose item the installer
//                                                                 just chose with a CHOOSE_ITEM button
//   <tool-result tool="get_work_order">{…}</tool-result>          a read the worker already ran in this turn (ADR-0028)
//
// The untrusted text is sealed by channels/normalizer.ts (`untrustedBlocks`): escaped, inside a block
// whose random name is declared only in the `<session>` header and appears in no content of the
// envelope, so an installer can never close the block and forge an `<event>`, `<facts>`, `<session>`
// or `<tool-result>`. Every other value is escaped as an attribute or a JSON escape. The preloaded
// results sit outside the untrusted block (the system prompt reads them as data, never instructions).
// Pure on purpose: turns/ gathers the inputs from the connector.
import { PhotoItem, TurnTrigger } from "@cuadrilla/shared";
import { type RandomBytes, type UntrustedBlockInput, escapeAttribute, sessionHeader, untrustedBlocks } from "../channels/normalizer";

export interface EnvelopeEvent {
  readonly type: TurnTrigger;
  /** `eventId` of the queue event that opened the turn. */
  readonly id: string;
  /** Simulated instant of the event, ISO 8601 with the world's offset. */
  readonly at: string;
  /** Public number of the work order (`24817`), when the turn has one. */
  readonly workOrder?: string;
}

export type FactValue = string | number | boolean;

/** One line of `<facts>`: a name and its attributes, all rendered escaped. */
export interface FactLine {
  readonly name: string;
  readonly attributes: Readonly<Record<string, FactValue>>;
}

/** A photo the installer sent: only its id and size travel; the image never reaches the Harness (ADR-0015). */
export interface AttachmentLine {
  readonly kind: "IMAGE";
  readonly candidateId: string;
  readonly bytes?: number;
  /** The item the installer chose for this photo with a CHOOSE_ITEM button (never a guess of code or model). */
  readonly item?: PhotoItem;
}

/** A read tool the worker ran with the turn's token before the Harness (ADR-0028): the tool's own answer. */
export interface PreloadedResult {
  readonly tool: string;
  readonly output: unknown;
}

export interface EnvelopeInput {
  readonly sessionToken: string;
  readonly event: EnvelopeEvent;
  readonly facts: readonly FactLine[];
  /** Normalized, masked untrusted texts of the turn (the installer's text or transcript). */
  readonly untrusted: readonly UntrustedBlockInput[];
  readonly attachments?: readonly AttachmentLine[];
  readonly preloaded?: readonly PreloadedResult[];
}

export interface RenderedEnvelope {
  readonly text: string;
  /** The block name of the turn (`inbound-<6 hex>`). */
  readonly delim: string;
}

/** At most this many attachment lines (one turn answers one inbound message). */
export const MAX_ENVELOPE_ATTACHMENTS = 5;
const MAX_DELIMITER_DRAWS = 16;

const NAME = /^[a-z][a-zA-Z0-9-]{0,31}$/;
const ATTRIBUTE = /^[a-zA-Z][a-zA-Z0-9-]{0,31}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const EVENT_ID = /^[A-Za-z0-9_.:#=+/-]{1,128}$/;
const CANDIDATE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const WORK_ORDER_NUMBER = /^\d{5}$/;

function attributes(values: Readonly<Record<string, FactValue>>): string {
  return Object.entries(values)
    .map(([name, value]) => {
      if (!ATTRIBUTE.test(name)) throw new RangeError(`invalid envelope attribute "${name}"`);
      return ` ${name}="${escapeAttribute(String(value))}"`;
    })
    .join("");
}

function eventLine(event: EnvelopeEvent): string {
  const type = TurnTrigger.parse(event.type);
  if (!EVENT_ID.test(event.id)) throw new RangeError("the envelope event needs an event id");
  if (Number.isNaN(Date.parse(event.at))) throw new RangeError("the envelope event needs an instant");
  if (event.workOrder !== undefined && !WORK_ORDER_NUMBER.test(event.workOrder)) throw new RangeError("the envelope event needs a work order number");
  return `<event${attributes({ type, id: event.id, at: event.at, ...(event.workOrder === undefined ? {} : { workOrder: event.workOrder }) })}/>`;
}

function factsBlock(facts: readonly FactLine[]): string {
  const lines = facts.map((fact) => {
    if (!NAME.test(fact.name)) throw new RangeError(`invalid fact name "${fact.name}"`);
    return `${fact.name}${attributes(fact.attributes)}`;
  });
  return ["<facts>", ...lines, "</facts>"].join("\n");
}

function attachmentLine(attachment: AttachmentLine): string {
  if (!CANDIDATE_ID.test(attachment.candidateId)) throw new RangeError("invalid candidate id");
  if (attachment.bytes !== undefined && (!Number.isInteger(attachment.bytes) || attachment.bytes < 0)) throw new RangeError("bytes must be a size");
  const values: Record<string, FactValue> = { kind: attachment.kind, candidateId: attachment.candidateId };
  if (attachment.bytes !== undefined) values.bytes = attachment.bytes;
  if (attachment.item !== undefined) values.item = PhotoItem.parse(attachment.item);
  return `<attachment${attributes(values)}/>`;
}

/**
 * The tool's JSON with `<`, `>` and `&` as JSON escapes: still the same JSON to read, and no value the
 * tool returned (a customer's street, a name) can close the element or open another one.
 */
export function preloadedLine(result: PreloadedResult): string {
  if (!TOOL_NAME.test(result.tool)) throw new RangeError(`invalid preloaded tool "${result.tool}"`);
  const json = JSON.stringify(result.output ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return `<tool-result tool="${result.tool}">${json}</tool-result>`;
}

/**
 * The envelope text of a turn. The block name is drawn again while it appears anywhere else in the
 * envelope (facts, attachments, preloaded results), so nothing outside the block can name it either.
 * Throws on a malformed fixed part: a bug, never a message.
 */
export function renderEnvelope(input: EnvelopeInput, random?: RandomBytes): RenderedEnvelope {
  const attachments = input.attachments ?? [];
  if (attachments.length > MAX_ENVELOPE_ATTACHMENTS) throw new RangeError(`at most ${MAX_ENVELOPE_ATTACHMENTS} attachment lines`);
  const trusted = [eventLine(input.event), factsBlock(input.facts), ...attachments.map(attachmentLine)];
  const results = (input.preloaded ?? []).map(preloadedLine);
  const outside = [...trusted, ...results].join("\n").toLowerCase();
  for (let draw = 0; draw < MAX_DELIMITER_DRAWS; draw += 1) {
    const sealed = untrustedBlocks(input.untrusted, random);
    if (outside.includes(sealed.delim.slice("inbound-".length))) continue;
    const [event, facts, ...attachmentLines] = trusted;
    const text = [sessionHeader(input.sessionToken, sealed.delim), event, facts, ...sealed.blocks, ...attachmentLines, ...results].join("\n");
    return { text, delim: sealed.delim };
  }
  throw new Error("no block name is absent from the envelope");
}
