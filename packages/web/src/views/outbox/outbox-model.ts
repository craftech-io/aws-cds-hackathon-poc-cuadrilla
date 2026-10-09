// What the outbox shows of `outbox.list` / `outbox.get` (packages/bff/src/routers/outbox.ts): each email's
// kind, recipient and status in words, its SES events in order, and the tone of its status. Pure.
import type { BadgeTone } from "../../components/Badge";
import { codeLabel } from "../../lib/code-label";
import type { RouterOutputs } from "../../lib/trpc-router";
import { outboxCopy as copy } from "./copy";

export type MailRow = RouterOutputs["outbox"]["list"][number];
export type MailDetail = RouterOutputs["outbox"]["get"];

const STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  DELIVERED: "success",
  SENT: "info",
  QUEUED: "neutral",
  DELAYED: "warning",
  BOUNCED: "danger",
  COMPLAINED: "danger",
  FAILED: "danger",
  DENIED: "warning",
};

export function statusTone(status: string): BadgeTone {
  return STATUS_TONES[status] ?? "neutral";
}

export function recipientText(mail: Pick<MailRow, "toRole" | "to">): string {
  return `${codeLabel(copy.roles, mail.toRole)} · ${mail.to}`;
}

/** The events oldest first, as SES reported them. */
export function eventsInOrder(events: MailRow["events"]): MailRow["events"] {
  return [...events].sort((a, b) => Date.parse(a.atReal) - Date.parse(b.atReal));
}

/** The last event, the one a row summarises with. */
export function lastEvent(events: MailRow["events"]): MailRow["events"][number] | undefined {
  return eventsInOrder(events).at(-1);
}

/** `HH:MM:SS` of a real instant in the viewer's time. */
export function realClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}
