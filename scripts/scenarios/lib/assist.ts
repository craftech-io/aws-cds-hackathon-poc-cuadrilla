// What most units do, in one place: a person of the world writes, taps, sends a voice note or a photo
// through `wa.inbound` (the simulator's path); the unit waits for quiescence and reads a snapshot of the
// orders and people it asserts on; and the negatives every unit with turns repeats (no forbidden pattern
// in any outgoing message, no turn stopped by `max_tokens`).
import type { Message } from "../../../packages/bff/src/domain/conversations";
import type { InboundContent } from "../../../packages/bff/src/qa-driver/contract-inputs";
import type { OrderSnapshot, PersonSnapshot, QaSnapshot } from "../../../packages/bff/src/qa-driver/snapshot";
import { esMX } from "../../../packages/bff/src/copy/es-MX";
import { type ScenarioContext, ensure } from "./context";
import { normalizeFacts, outboundViolations } from "./oracles";
import type { World } from "./world";

export type Identity = string | "UNKNOWN";

export function send(ctx: ScenarioContext, world: Pick<World, "clockId">, identity: Identity, content: InboundContent): Promise<{ wamid: string; sentAtReal: string }> {
  return ctx.qa("wa.inbound", { clockId: world.clockId, identity, content });
}

export const say = (ctx: ScenarioContext, world: Pick<World, "clockId">, identity: Identity, text: string) => send(ctx, world, identity, { type: "text", text });
export const tap = (ctx: ScenarioContext, world: Pick<World, "clockId">, identity: Identity, action: Extract<InboundContent, { type: "button" }>["action"], options: { readonly fromPersonId?: string; readonly objectId?: string } = {}) =>
  send(ctx, world, identity, { type: "button", action, ...options });
export const voice = (ctx: ScenarioContext, world: Pick<World, "clockId">, identity: Identity, voiceId: string) => send(ctx, world, identity, { type: "voice", voiceId });
export const photo = (ctx: ScenarioContext, world: Pick<World, "clockId">, identity: Identity, photoId: string) => send(ctx, world, identity, { type: "photo", photoId });

/** Waits for the installer's quiescence and reads the orders and people named. */
export function settledOn(ctx: ScenarioContext, world: Pick<World, "clockId">, installerId: string, workOrderIds: readonly string[], personIds: readonly string[] = [installerId], timeoutSec?: number): Promise<QaSnapshot> {
  return ctx.settled({ installerId }, { clockId: world.clockId, workOrderIds, personIds }, timeoutSec);
}

/** Waits for the world's quiescence (no installer: unknown numbers, foreign events, supervisors' keywords). */
export function settledWorld(ctx: ScenarioContext, world: Pick<World, "clockId">, workOrderIds: readonly string[] = [], personIds: readonly string[] = []): Promise<QaSnapshot> {
  return ctx.settled({ clockId: world.clockId }, { clockId: world.clockId, workOrderIds, personIds });
}

export function orderIn(snapshot: QaSnapshot, workOrderId: string): OrderSnapshot {
  const order = snapshot.orders.find((entry) => entry.order.workOrderId === workOrderId);
  ensure(order !== undefined, `the snapshot has no order ${workOrderId}`);
  return order;
}

export function personIn(snapshot: QaSnapshot, personId: string): PersonSnapshot {
  const person = snapshot.people.find((entry) => entry.personId === personId);
  ensure(person !== undefined, `the snapshot has no person ${personId}`);
  return person;
}

/** Messages sent after `sinceIso` (real time), oldest first. */
export function since(messages: readonly Message[], sinceIso: string): Message[] {
  return messages.filter((message) => (message.sentAtReal ?? "") >= sinceIso || message.createdAt >= sinceIso);
}

/** Whether a message is the fixed notice of `copy/es-MX.ts` with this key (normalized comparison). */
export function isNotice(message: Pick<Message, "text">, key: keyof typeof esMX): boolean {
  const copy = esMX[key];
  return typeof copy === "string" && message.text !== undefined && normalizeFacts(message.text) === normalizeFacts(copy);
}

/** Every outgoing message of the snapshot (orders' timelines and people's threads), without repeats. */
export function allMessages(snapshot: QaSnapshot): Message[] {
  const byId = new Map<string, Message>();
  for (const message of [...snapshot.orders.flatMap((order) => order.messages), ...snapshot.people.flatMap((person) => person.messages)]) byId.set(`${message.personId}/${message.messageId}`, message);
  return [...byId.values()];
}

/** §4.3 negatives of every unit with turns: no forbidden pattern outbound and no turn stopped by `max_tokens`. */
export function assertCleanOutbound(ctx: ScenarioContext, snapshot: QaSnapshot): void {
  const violations = outboundViolations(allMessages(snapshot));
  ctx.check(violations.length === 0, `outgoing messages with forbidden patterns: ${violations.join("; ")}`);
  const cut = [...snapshot.orders.flatMap((order) => order.turnNotes), ...snapshot.people.flatMap((person) => person.turnNotes)].filter((note) => note.stopReason === "max_tokens");
  ctx.check(cut.length === 0, `${cut.length} turn(s) stopped by max_tokens`);
}

/** Decisions of the world (or of an order) with this verdict and rule. */
export function decided(decisions: QaSnapshot["decisions"], decision: string, ruleId?: string, action?: string) {
  return decisions.filter((entry) => entry.decision === decision && (ruleId === undefined || entry.ruleIds.includes(ruleId)) && (action === undefined || entry.action === action));
}

/** Decisions of a worker or channel action (`TURN_CAP`, `GUARDRAIL_MASK`, `TIMER_STALE`…), whatever their verdict. */
export function withAction(decisions: QaSnapshot["decisions"], action: string) {
  return decisions.filter((entry) => entry.action === action);
}

/** The world's simulated date and time as `America/Mexico_City` (`2026-10-13T09:15:00-06:00`). */
export function at(date: string, time: string): string {
  return `${date}T${time}:00-06:00`;
}

export const DAY = "2026-10-13";
