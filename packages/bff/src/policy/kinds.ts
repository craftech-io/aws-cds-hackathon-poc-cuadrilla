// The `MessageKind` → channel matrix of docs/design-brief.md §3, which `CP-KIND-CHANNEL` applies to
// every message: who may receive each kind, on which channel, in which forms and written by whom,
// and which templates render it. The agent writes only `REPLY` and `ORDERS_DETAIL` to an installer
// (ADR-0014); supervisors, zone chiefs and customers receive only templates, fixed texts of copy/ or
// the verified summary, all written by code. Kind groups the time rules read live here too.
import type { MessageKind, SendChannel, TemplateName } from "@cuadrilla/shared";
import type { AuthorKind, EmailRole, MessageForm } from "./types";

/** Who a kind is addressed to: a WhatsApp identity by role, a number outside the list, or an email role. */
export type Audience = "INSTALLER" | "SUPERVISOR" | "UNKNOWN_NUMBER" | EmailRole;

export interface KindRule {
  readonly channel: SendChannel;
  readonly audiences: readonly Audience[];
  /** Forms the kind may take, each with the authors allowed to write it in that form. */
  readonly forms: Readonly<Partial<Record<MessageForm, readonly AuthorKind[]>>>;
  /** Templates that render the kind (form `TEMPLATE`). */
  readonly templates?: readonly TemplateName[];
}

const AGENT = ["AGENT"] as const;
const SYSTEM = ["SYSTEM"] as const;
const PERSON = ["PERSON"] as const;

export const KIND_CHANNEL_MATRIX: Readonly<Record<MessageKind, KindRule>> = {
  DAY_START: { channel: "WHATSAPP", audiences: ["INSTALLER"], forms: { TEMPLATE: SYSTEM }, templates: ["ordenes_del_dia"] },
  // Free text of the agent; the template is the fallback of a live `131047` failure (WINDOW_FALLBACK).
  ORDERS_DETAIL: { channel: "WHATSAPP", audiences: ["INSTALLER"], forms: { TEXT: AGENT, INTERACTIVE: AGENT, TEMPLATE: SYSTEM }, templates: ["ordenes_del_dia"] },
  REPLY: { channel: "WHATSAPP", audiences: ["INSTALLER"], forms: { TEXT: AGENT, INTERACTIVE: AGENT } },
  // A fixed text of copy/, or a fixed prompt with a list (the supervisor's "¿Sobre cuál caso?", FL-064).
  SYSTEM_NOTICE: { channel: "WHATSAPP", audiences: ["INSTALLER", "SUPERVISOR", "UNKNOWN_NUMBER"], forms: { TEXT: SYSTEM, INTERACTIVE: SYSTEM } },
  ORDER_CHOICE: { channel: "WHATSAPP", audiences: ["INSTALLER"], forms: { INTERACTIVE: SYSTEM } },
  SAFETY_INSTRUCTION: { channel: "WHATSAPP", audiences: ["INSTALLER"], forms: { TEXT: SYSTEM } },
  CASE_NOTICE: { channel: "WHATSAPP", audiences: ["INSTALLER"], forms: { TEXT: SYSTEM } },
  // Plan B: the same body as an interactive message inside the supervisor's window ("TURNO").
  CASE_REQUEST: { channel: "WHATSAPP", audiences: ["SUPERVISOR"], forms: { TEMPLATE: SYSTEM, INTERACTIVE: SYSTEM }, templates: ["caso_escalado", "caso_reasignado"] },
  SAFETY_ALERT: { channel: "WHATSAPP", audiences: ["SUPERVISOR"], forms: { TEMPLATE: SYSTEM, INTERACTIVE: SYSTEM }, templates: ["alerta_seguridad"] },
  CASE_BRIEF: { channel: "WHATSAPP", audiences: ["SUPERVISOR"], forms: { TEXT: SYSTEM, INTERACTIVE: SYSTEM, IMAGE: SYSTEM } },
  CASE_TAKEN_NOTICE: { channel: "WHATSAPP", audiences: ["SUPERVISOR"], forms: { TEXT: SYSTEM } },
  RELAY: { channel: "WHATSAPP", audiences: ["INSTALLER", "SUPERVISOR"], forms: { TEXT: PERSON, IMAGE: PERSON } },
  SUPERVISOR_REPLY_TEMPLATE: { channel: "WHATSAPP", audiences: ["INSTALLER"], forms: { TEMPLATE: SYSTEM }, templates: ["respuesta_supervisor"] },
  CERTIFICATE: { channel: "WHATSAPP", audiences: ["INSTALLER"], forms: { DOCUMENT: SYSTEM, TEMPLATE: SYSTEM }, templates: ["acta_instalacion"] },
  CERTIFICATE_EMAIL: { channel: "EMAIL", audiences: ["CUSTOMER", "OPS_MAILBOX"], forms: { EMAIL: SYSTEM } },
  ZONE_CHIEF_ALERT: { channel: "EMAIL", audiences: ["ZONE_CHIEF"], forms: { EMAIL: SYSTEM } },
  // Not content: the read receipt with the typing indicator (FL-102) and the verdict reaction (FL-103).
  READ_ACK: { channel: "WHATSAPP", audiences: ["INSTALLER"], forms: { READ_ACK: SYSTEM } },
  VERDICT_REACTION: { channel: "WHATSAPP", audiences: ["INSTALLER"], forms: { REACTION: SYSTEM } },
};

/** Physical safety: never deferred by quiet hours (docs/design-brief.md §5.9). */
export const SAFETY_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(["SAFETY_INSTRUCTION", "SAFETY_ALERT"]);

/** Messages of a case: exempt from quiet hours while the case is open. */
export const CASE_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  "CASE_NOTICE",
  "CASE_REQUEST",
  "SAFETY_ALERT",
  "CASE_BRIEF",
  "CASE_TAKEN_NOTICE",
  "RELAY",
  "SUPERVISOR_REPLY_TEMPLATE",
  "ZONE_CHIEF_ALERT",
]);

/** Acknowledgements of an inbound message: never proactive. */
export const ACK_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(["READ_ACK", "VERDICT_REACTION"]);

/** Messages only supervisors of the shift roster may receive (`CP-ROSTER`). */
export const ROSTER_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(["CASE_REQUEST", "SAFETY_ALERT", "CASE_BRIEF"]);

/** Messages that carry the certificate (`CP-CERT-EVIDENCE`). */
export const CERTIFICATE_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>(["CERTIFICATE", "CERTIFICATE_EMAIL"]);

/** Forms that are free content, which WhatsApp admits only inside the 24 h window. */
export function needsServiceWindow(form: MessageForm): boolean {
  return form !== "TEMPLATE" && form !== "EMAIL";
}
