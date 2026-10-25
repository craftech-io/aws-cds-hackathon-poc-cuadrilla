// Pure rules of the phone simulator (FL-082, FL-083, FL-102): who the phone is at first, what the
// chat shows (only what reached the phone, oldest first, with each reaction on the bubble it reacts to
// and the read receipt as ticks, never as a bubble), the ticks of a bubble, "El agente está
// escribiendo…" while a turn runs after an installer's message that Cuadrilla already read, how a
// photo or a voice note of the synthetic set is named on screen (never by its id), the checks on a
// photo before it is uploaded and how a cap or a pause is told. No React here: simulator-model.test.ts.
import { BUTTON_LABELS } from "@cuadrilla/bff/copy/buttons";
import type { Weekday } from "@cuadrilla/shared";
import type { ApiError } from "../../lib/api-error";
import { type PendingWork, simTimeParts } from "../../lib/world-clock";
import { type PhotoFamily, simulatorCopy } from "./copy";
import { type Bubble, type CatalogPhoto, type CatalogVoice, MAX_PHOTO_BYTES, type SimIdentity, UNKNOWN_IDENTITY } from "./simulator-api";

/** Outbound statuses that never reached the phone: held, waiting or refused by the contact policy. */
const NOT_ON_PHONE: ReadonlySet<string> = new Set(["QUEUED", "DEFERRED", "DENIED"]);
/** Contents that are not a bubble of their own: the read receipt shows as ticks, a reaction on its bubble. */
const NOT_A_BUBBLE: ReadonlySet<string> = new Set(["READ_ACK", "REACTION"]);

/** The person of the main story the phone opens as (the `guest` template clones `inst-rogelio`). */
export const STORY_INSTALLER = "inst-rogelio";

/** The identity asked for (`?identity=` by id or by the story's party), else the story's installer, else the first one. */
export function defaultIdentity(identities: readonly SimIdentity[], asked: string | null | undefined): string {
  const byParty = (party: string) => identities.find((item) => item.identity === party) ?? identities.find((item) => item.identity.startsWith(`${party}-`));
  const found = (asked ? byParty(asked) : undefined) ?? byParty(STORY_INSTALLER) ?? identities.find((item) => item.identity !== UNKNOWN_IDENTITY) ?? identities[0];
  return found?.identity ?? UNKNOWN_IDENTITY;
}

export function nameOf(identity: SimIdentity | undefined): string {
  if (identity === undefined || identity.identity === UNKNOWN_IDENTITY) return simulatorCopy.identity.unknown;
  return [identity.firstName, identity.lastName].filter((part): part is string => Boolean(part)).join(" ") || simulatorCopy.identity.unknown;
}

export interface PhoneItem {
  readonly bubble: Bubble;
  /** Reactions on this bubble, in the order they arrived. */
  readonly reactions: readonly string[];
}

const realOf = (bubble: Bubble): number => (bubble.sentAtReal ? Date.parse(bubble.sentAtReal) : Number.NaN);

/** Simulated time first; within one simulated instant (a paused clock), the order they were stored in. */
const byTime = (a: Bubble, b: Bubble) => Date.parse(a.sentAtSim) - Date.parse(b.sentAtSim) || realOf(a) - realOf(b) || a.messageId.localeCompare(b.messageId);

/** The chat as the phone shows it. */
export function phoneItems(bubbles: readonly Bubble[]): PhoneItem[] {
  const reached = [...bubbles].filter((bubble) => !(bubble.direction === "OUT" && NOT_ON_PHONE.has(bubble.status))).sort(byTime);
  const shown = reached.filter((bubble) => !NOT_A_BUBBLE.has(bubble.content));
  const reactions = new Map<string, string[]>();
  for (const bubble of reached) {
    if (bubble.reaction === null) continue;
    const list = reactions.get(bubble.reaction.to) ?? [];
    list.push(bubble.reaction.emoji);
    reactions.set(bubble.reaction.to, list);
  }
  return shown.map((bubble) => ({ bubble, reactions: (bubble.providerMessageId === null ? undefined : reactions.get(bubble.providerMessageId)) ?? [] }));
}

export interface DayGroup {
  /** "mar 13/10". */
  readonly day: string;
  readonly items: readonly PhoneItem[];
}

/** Items grouped by simulated day, like the day chips of WhatsApp. */
export function byDay(items: readonly PhoneItem[], weekdays: Readonly<Record<Weekday, string>>): DayGroup[] {
  const groups: { day: string; items: PhoneItem[] }[] = [];
  for (const item of items) {
    const parts = simTimeParts(item.bubble.sentAtSim);
    const day = `${weekdays[parts.weekday]} ${parts.dayMonth}`;
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

/** "09:20": the hour of a bubble, in the world's own time. */
export function timeOf(bubble: Pick<Bubble, "sentAtSim">): string {
  return simTimeParts(bubble.sentAtSim).time;
}

export interface Ticks {
  readonly symbol: "✓" | "✓✓" | "!";
  readonly read: boolean;
  readonly label: string;
}

/**
 * ✓ sent, ✓✓ delivered, ✓✓ highlighted once read, ! failed. On the person's own messages, ✓✓ once
 * Cuadrilla received them and highlighted once it read them (the read receipt of FL-102).
 */
export function ticksOf(bubble: Pick<Bubble, "direction" | "status">): Ticks | undefined {
  const t = simulatorCopy.ticks;
  if (bubble.direction === "IN") return bubble.status === "READ" ? { symbol: "✓✓", read: true, label: t.READ_BY_CUADRILLA } : { symbol: "✓✓", read: false, label: t.RECEIVED };
  switch (bubble.status) {
    case "SENT":
      return { symbol: "✓", read: false, label: t.SENT };
    case "DELIVERED":
      return { symbol: "✓✓", read: false, label: t.DELIVERED };
    case "READ":
      return { symbol: "✓✓", read: true, label: t.READ };
    case "FAILED":
      return { symbol: "!", read: false, label: t.FAILED };
    default:
      return undefined;
  }
}

/** What a bubble reads: its text, or the label of the button the person tapped. */
export function textOf(bubble: Pick<Bubble, "text" | "buttonAction" | "direction">): string | null {
  if (bubble.text !== null && bubble.text !== "") return bubble.text;
  return bubble.buttonAction === null ? null : BUTTON_LABELS[bubble.buttonAction].es;
}

const TYPING_WORK: ReadonlySet<string> = new Set(["TURN", "TRANSCRIBE", "VALIDATION", "EVENT"]);

/** The agent is writing: the person's last message was read by Cuadrilla, nothing answered it yet, and the world is working. */
export function isTyping(items: readonly PhoneItem[], busy: boolean, pending: readonly PendingWork[]): boolean {
  const last = items.at(-1)?.bubble;
  if (last === undefined || last.direction !== "IN" || last.status !== "READ") return false;
  return busy && pending.some((work) => TYPING_WORK.has(work.kind));
}

/** Messages of Cuadrilla the person has not read yet ("Marcar como leídos"). */
export function unreadCount(items: readonly PhoneItem[]): number {
  return items.filter((item) => item.bubble.direction === "OUT" && (item.bubble.status === "SENT" || item.bubble.status === "DELIVERED")).length;
}

const PHOTO_NAME = /^ph-([a-z]+)-(\d+)$/;
const FAMILIES: ReadonlySet<string> = new Set(["meter", "label", "rosette", "adv", "hist", "story"]);

/** "Medidor 01": a photo of the set by its family and number, never by its id. */
export function photoLabel(photo: Pick<CatalogPhoto, "photoId">): string {
  const match = PHOTO_NAME.exec(photo.photoId);
  const family = (match !== null && FAMILIES.has(match[1] ?? "") ? match[1] : "other") as PhotoFamily;
  return `${simulatorCopy.photos.family[family]} ${match?.[2] ?? ""}`.trim();
}

/** What the validation is expected to say of a photo of the set. */
export function photoExpectation(photo: Pick<CatalogPhoto, "expectedVerdict" | "expectedReason">): string {
  if (photo.expectedVerdict === "PASS") return simulatorCopy.photos.pass;
  if (photo.expectedVerdict === "UNSURE") return simulatorCopy.photos.unsure;
  return simulatorCopy.photos.reject(photo.expectedReason);
}

/** "0:07". */
export function durationText(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** "Nota 1 · 0:03": a voice note of the set by its position, never by its id. */
export function voiceLabel(voice: Pick<CatalogVoice, "durationSec">, index: number): string {
  return simulatorCopy.voice.sample(index + 1, durationText(voice.durationSec));
}

export type PhotoProblem = "notJpeg" | "tooLarge" | "empty";

/** What the simulator checks before asking for an upload (the presigned POST and the BFF check again). */
export function photoProblem(file: Pick<File, "type" | "size" | "name">): PhotoProblem | undefined {
  const jpeg = file.type === "image/jpeg" || (file.type === "" && /\.jpe?g$/i.test(file.name));
  if (!jpeg) return "notJpeg";
  if (file.size <= 0) return "empty";
  if (file.size > MAX_PHOTO_BYTES) return "tooLarge";
  return undefined;
}

export interface CapNotice {
  readonly text: string;
  /** When the cap frees, as an instant; absent when the BFF did not say. */
  readonly untilIso?: string;
}

const UNTIL = /until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)/;

/** A refusal of a cap or of the paused simulator, as the person reads it; undefined for any other error. */
export function capNoticeOf(error: ApiError): CapNotice | undefined {
  const reasons = simulatorCopy.caps.reasons;
  if (error.reason === "KILL_SWITCH_ACTIVE") return { text: reasons.KILL_SWITCH_ACTIVE ?? simulatorCopy.caps.fallback };
  if (error.code !== "TOO_MANY_REQUESTS") return undefined;
  const text = (error.reason === null ? undefined : reasons[error.reason]) ?? simulatorCopy.caps.fallback;
  const until = UNTIL.exec(error.message)?.[1];
  return until === undefined ? { text } : { text, untilIso: until };
}

/** "14:00" in the viewer's own clock: when a cap of real time frees. */
export function localTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The text of a refusal the simulator knows better than the console's generic one. */
export function simulatorErrorText(error: ApiError): string | undefined {
  return error.reason === null ? undefined : simulatorCopy.errors[error.reason];
}
