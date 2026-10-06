// What the cases module (docs/design-brief.md §5.8-§5.9) needs from the rest of the product, as ports:
//
//   CaseOutbound    the outbound pipeline (packages/bff/src/outbound/, WP-28): every message of a case
//                   leaves through it, so the contact policy decides and the audit log records it. The
//                   ladder reads the decision back to choose plan B or to skip a rung; it never decides
//                   a channel on its own. The pipeline resolves the address from the person (never from
//                   the caller), issues the button nonces bound to that phone and renders the zone
//                   chief's email with the world's brand and the console link.
//   SummaryCheck    G2 and the deterministic fact check over a summary the agent wrote (`escalate_case`)
//   CaseTurnQueue   `AGENT_TURN(CASE_CLOSED)` on the installer's FIFO group (ADR-0017)
//   TimerPort       `TIMER#CASE_TIMEOUT` (agent-tools/common/ports.ts, implemented by timers/)
//
// Nothing here talks to AWS: the Lambdas wire the real adapters, the tests the fakes of testing.ts.
import type { ContactRule, MessageKind, TemplateName, WaButtonAction } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import type { Actor, JsonObject } from "../domain/common";
import type { NonceObject } from "../domain/runtime";
import type { Clock } from "../lib/clock";
import type { Logger } from "../lib/log";
import type { NetworkClient } from "../network/client";
import type { TimerPort } from "../agent-tools/common/ports";

/** A button the pipeline turns into a nonce bound to the recipient's phone, the object and the action. */
export interface CaseButton {
  readonly action: Extract<WaButtonAction, "TAKE_CASE" | "DECLINE_CASE" | "CLOSE_CASE" | "VIEW_REPLY">;
  readonly object: NonceObject;
}

/** Media a message carries: an evidence photo (`Evidence`) or a photo the other side sent (`Media`). */
export interface CaseMedia {
  readonly bucket: "EVIDENCE" | "MEDIA";
  readonly s3Key: string;
  readonly mime: string;
}

interface CaseSendBase {
  readonly clockId: string;
  readonly ispId: string;
  /** The recipient, by person: the pipeline resolves phone and transport (`LAM-RECIPIENT`). */
  readonly personId: string;
  readonly kind: MessageKind;
  /** `SYSTEM` for the ladder's texts; `PERSON:<id>` for what a person wrote on the bridge. */
  readonly author: Actor;
  readonly caseId?: string;
  readonly workOrderId?: string;
  /** Simulated instant of the decision (the event, or the due time of a timeout). */
  readonly atSim: string;
  /** Deterministic id: a redelivered event never sends the same message twice. */
  readonly messageId: string;
  /** Copy key of a `SYSTEM_NOTICE`. */
  readonly notice?: string;
  /** The message answers an inbound of the recipient (a tap): quiet hours do not apply. */
  readonly inResponseToInbound?: boolean;
  readonly refs?: JsonObject;
}

export type CaseWhatsAppSend =
  | (CaseSendBase & { readonly form: "TEXT"; readonly text: string })
  | (CaseSendBase & { readonly form: "INTERACTIVE"; readonly text: string; readonly buttons: readonly CaseButton[] })
  | (CaseSendBase & { readonly form: "TEMPLATE"; readonly templateName: TemplateName; readonly params: readonly string[]; readonly buttons: readonly CaseButton[] })
  | (CaseSendBase & { readonly form: "IMAGE"; readonly media: CaseMedia; readonly caption?: string });

/** `ZONE_CHIEF_ALERT` by SES; the pipeline renders it with copy/es-MX-documents.ts and the world's brand. */
export interface ZoneChiefAlertSend {
  readonly clockId: string;
  readonly ispId: string;
  readonly zoneChiefId: string;
  readonly caseId: string;
  readonly workOrderId: string;
  /** `SAFETY`: `zoneChiefSafetyAlert` from the start; `UNATTENDED`: `zoneChiefUnattendedCase`. */
  readonly variant: "SAFETY" | "UNATTENDED";
  /** Hazard or case category in words (copy `hazard` / `caseReason`), built by code. */
  readonly reasonText: string;
  readonly summary: string;
  readonly installerFirstName: string;
  readonly atSim: string;
  readonly messageId: string;
}

/** What the policy (through the pipeline) did with one message. */
export type CaseSendOutcome =
  | { readonly status: "SENT"; readonly messageId: string }
  | { readonly status: "DEFERRED"; readonly messageId: string; readonly nextAllowedAt?: string }
  | { readonly status: "DENIED"; readonly messageId?: string; readonly deniedBy?: ContactRule; readonly reason?: string };

export interface CaseOutbound {
  sendWhatsApp(request: CaseWhatsAppSend): Promise<CaseSendOutcome>;
  sendZoneChiefAlert(request: ZoneChiefAlertSend): Promise<CaseSendOutcome>;
}

export interface SummaryCheckInput {
  readonly ispId: string;
  readonly clockId: string;
  /** The turn whose tool results ground the summary (G2's `grounding_source`). */
  readonly turnId?: string;
  readonly workOrderId: string;
  /** Already masked. */
  readonly text: string;
}

/** G2 (grounding against the turn's tool results) plus the deterministic fact check of outbound/verify. */
export interface SummaryCheck {
  verify(input: SummaryCheckInput): Promise<{ readonly ok: boolean; readonly reason?: string }>;
}

export interface CaseClosedTurn {
  readonly clockId: string;
  readonly ispId: string;
  readonly installerId: string;
  readonly workOrderId: string;
  readonly caseId: string;
  /** What was said over the bridge, masked, for the agent to resume (escaped by the envelope). */
  readonly summary: string;
  readonly atSim: string;
  /** Deterministic event id (`MessageDeduplicationId`). */
  readonly eventId: string;
}

export interface CaseTurnQueue {
  /** Marks the event in flight and enqueues `AGENT_TURN(CASE_CLOSED)` on the installer's group. */
  enqueueCaseClosed(turn: CaseClosedTurn): Promise<void>;
}

/** Everything the deterministic case handlers use. */
export interface CaseDeps {
  readonly connector: Connector;
  readonly outbound: CaseOutbound;
  readonly timers: TimerPort;
  readonly turns: CaseTurnQueue;
  /** `SUPERVISOR_FIX` when a supervisor's relay reaches the installer (docs/architecture-integrations.md §6). */
  readonly network: Pick<NetworkClient, "reportPhysicalAction">;
  /** Real time: case ids, history stamps and the RUNNING mode of the world clock. */
  readonly realClock: Clock;
  readonly logger: Logger;
  /** Case ids; `case-<ULID of real now>` by default. */
  readonly newCaseId?: () => string;
}
