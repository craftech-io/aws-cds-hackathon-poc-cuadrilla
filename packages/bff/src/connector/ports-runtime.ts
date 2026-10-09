// Ports of conversations, the audit log, reference catalogs, runtime state and metrics, plus the seed
// store the loader and the world factory use to write validated rows in bulk.
import type { AuditDecision, PhotoItem, RejectReason, TemplateName, TurnTrigger } from "@cuadrilla/shared";
import type { Decision, EvaluatedRule, AuditRefs } from "../domain/audit";
import type { Actor, JsonObject, NewEntity } from "../domain/common";
import type { EmailEvent, EmailStatus, Message, MessageEvent, MessagePolicy, MessageStatus, OutboundEmail, Transcript, TurnNote } from "../domain/conversations";
import type { ConversationKpi, EvalResult, KpiCounter, MetricSource } from "../domain/metrics";
import type { DomainTable } from "../domain/registry";
import type { z } from "zod";
import type { EvalPhoto, EvalQuestion, KbThreshold, ManualIndex, NameCheck, RateCard, REFERENCE_ENTITIES, ReferenceEntityName, RejectReasonCopy, Rubric, SafetyLexicon, Template } from "../domain/reference";
import type { CapCounter, Clock, Counter, CounterKind, Idempotency, Nonce, Session, Turn, TurnResult } from "../domain/runtime";
import type { Faults, InstallerState, JoinCode, LeaseKind, LiveWorld, PendingMail, PhoneLease, ProcessError, Probe, Tombstone, Upload, WorldSession, WorldState } from "../domain/runtime-world";
import type { Item, Key } from "./table-client";

export interface MessageRef {
  readonly personId: string;
  readonly sentAtSim: string;
  readonly messageId: string;
}

export interface MessagePatch {
  readonly status?: MessageStatus;
  readonly providerMessageId?: string;
  readonly transcript?: Transcript;
  readonly policy?: MessagePolicy;
  readonly sentAtReal?: string;
  readonly refs?: JsonObject;
}

export interface MailRef {
  readonly ispId: string;
  readonly sentAtSim: string;
  readonly mailId: string;
}

/** An entry of an order's timeline (`Conversations GSI2`). */
export type TimelineEntry = Message | OutboundEmail | TurnNote;

export interface ConversationsPort {
  appendMessage(message: NewEntity<typeof Message>): Promise<Message>;
  getMessage(ref: MessageRef): Promise<Message | undefined>;
  /** A person's message by id alone (candidate photos, nonces); reads the person's thread. */
  findMessage(personId: string, messageId: string): Promise<Message | undefined>;
  listMessages(personId: string, options?: { readonly fromSim?: string; readonly toSim?: string; readonly limit?: number; readonly descending?: boolean }): Promise<Message[]>;
  findMessageByProviderId(providerMessageId: string): Promise<Message | undefined>;
  updateMessage(ref: MessageRef, patch: MessagePatch): Promise<Message>;
  appendMessageEvent(event: NewEntity<typeof MessageEvent>): Promise<MessageEvent>;
  listMessageEvents(personId: string, messageId?: string): Promise<MessageEvent[]>;
  appendTurnNote(note: NewEntity<typeof TurnNote>): Promise<TurnNote>;
  listTurnNotes(personId: string, limit?: number): Promise<TurnNote[]>;
  /** Messages, emails and turn notes of an order, by simulated time. */
  listTimeline(workOrderId: string): Promise<TimelineEntry[]>;
  appendMail(mail: NewEntity<typeof OutboundEmail>): Promise<OutboundEmail>;
  getMail(ref: MailRef): Promise<OutboundEmail | undefined>;
  findMail(ispId: string, mailId: string): Promise<OutboundEmail | undefined>;
  findMailByProviderId(providerMessageId: string): Promise<OutboundEmail | undefined>;
  listOutbox(ispId: string, options?: { readonly limit?: number; readonly descending?: boolean }): Promise<OutboundEmail[]>;
  updateMail(ref: MailRef, patch: { readonly status?: EmailStatus; readonly providerMessageId?: string; readonly event?: EmailEvent }): Promise<OutboundEmail>;
}

export interface DecisionInput {
  readonly ispId: string;
  readonly clockId?: string;
  /** Simulated instant of the world; the row sorts by it (real time outside a world). */
  readonly atSim?: string;
  readonly decision: AuditDecision;
  readonly action: string;
  readonly ruleIds?: readonly string[];
  readonly evaluated?: readonly EvaluatedRule[];
  readonly messageId?: string;
  readonly trigger?: TurnTrigger;
  readonly actor: Actor;
  readonly refs?: AuditRefs;
  readonly reason?: string;
  readonly detail?: JsonObject;
}

export interface AuditPort {
  append(input: DecisionInput): Promise<Decision>;
  /** Decisions of an operator in a month (`yyyy-mm`), by time. */
  listByMonth(ispId: string, month: string, options?: { readonly limit?: number; readonly descending?: boolean }): Promise<Decision[]>;
  listByWorkOrder(workOrderId: string): Promise<Decision[]>;
  listByDecision(ispId: string, decision: AuditDecision, options?: { readonly fromTs?: string; readonly toTs?: string; readonly limit?: number }): Promise<Decision[]>;
}

type ReferenceSchemas = typeof REFERENCE_ENTITIES;

export interface ReferencePort {
  getTemplate(name: TemplateName): Promise<Template | undefined>;
  listTemplates(): Promise<Template[]>;
  getRubric(version: string, item: PhotoItem): Promise<Rubric | undefined>;
  listSafetyLexicon(version: string): Promise<SafetyLexicon[]>;
  listManualIndex(version: string): Promise<ManualIndex[]>;
  getKbThreshold(version: string): Promise<KbThreshold | undefined>;
  listEvalQuestions(): Promise<EvalQuestion[]>;
  listEvalPhotos(): Promise<EvalPhoto[]>;
  getRejectReasonCopy(reason: RejectReason): Promise<RejectReasonCopy | undefined>;
  listRateCard(): Promise<RateCard[]>;
  listNameChecks(): Promise<NameCheck[]>;
  /** Create or replace a catalog row (its key comes from its own fields). */
  put<E extends ReferenceEntityName>(entity: E, value: NewEntity<ReferenceSchemas[E]>): Promise<z.output<ReferenceSchemas[E]>>;
}

/** A plain counter move (`RATE#`, `UNKNOWN#`, `JUMP#`, `COUNTER#`); never a cost-cap key. */
export interface CounterReservation {
  readonly counterKey: string;
  readonly kind: CounterKind;
  readonly by: number;
  /** Ceiling: the reservation fails when the counter would exceed it. */
  readonly max?: number;
  /** Real-time TTL of the counter row (48 h by default; `EPOCH` never expires). */
  readonly ttlSeconds?: number;
}

export type ReservationResult = { readonly ok: true; readonly values: readonly number[] } | { readonly ok: false; readonly blockedBy: string };

export interface RuntimePort {
  /**
   * Writes `SESSION#<sessionId>` once (`SessionWriter` of services/session/session.ts); TTL 1 h, or
   * `expiresAt` (epoch seconds) when given.
   */
  putSession(session: NewEntity<typeof Session>, expiresAt?: number): Promise<void>;
  /** The session while it has not expired (`SessionStore.getSession`). */
  getSession(sessionId: string): Promise<Session | undefined>;
  /** `TURN#<turnId>` META; `undefined` while the turn runs (`SessionStore.getTurn`). */
  getTurn(turnId: string): Promise<Turn | undefined>;
  /** Closes a turn: every tool then rejects the tokens of its sessions. */
  closeTurn(turnId: string, details?: { readonly clockId?: string; readonly stopReason?: string }): Promise<Turn>;
  /** Stores a tool's redacted output under the next sequence of that tool in the turn. */
  putTurnResult(turnId: string, tool: string, output: JsonObject): Promise<TurnResult>;
  listTurnResults(turnId: string, tool?: string): Promise<TurnResult[]>;
  putNonce(nonce: NewEntity<typeof Nonce>, ttlSeconds?: number): Promise<Nonce>;
  /** The nonce while it has not expired. */
  getNonce(nonce: string): Promise<Nonce | undefined>;
  /** Counts a tap; NOT_FOUND when the nonce is missing or expired. */
  useNonce(nonce: string): Promise<Nonce>;
  /** Expires a nonce now (`nonce.expire` of the QaDriver). */
  expireNonce(nonce: string): Promise<void>;
  getClock(clockId: string): Promise<Clock | undefined>;
  createClock(clock: NewEntity<typeof Clock>): Promise<Clock>;
  /** Moves a clock only from the version the caller read (`WORLD_BUSY` races lose). */
  updateClock(clockId: string, patch: Partial<Omit<NewEntity<typeof Clock>, "clockId" | "ispId" | "kind">>, expectedVersion: number): Promise<Clock>;
  /** Next epoch of a world (`COUNTER#EPOCH#<clockId>`, ADD 1, never deleted, never goes back). */
  nextEpoch(clockId: string): Promise<number>;
  currentEpoch(clockId: string): Promise<number>;
  /** `true` the first time `(source, id)` is seen within 7 days. */
  claimIdempotency(source: string, id: string, result?: JsonObject): Promise<boolean>;
  /** Gives a claim back when its work failed before it was done, so a redelivery processes it again. */
  releaseIdempotency(source: string, id: string): Promise<void>;
  getIdempotency(source: string, id: string): Promise<Idempotency | undefined>;
  /**
   * All-or-nothing reservation of several plain counters with ceilings (rate limits, jumps, replies to
   * unknown numbers). Cost caps are reserved by ops/cost-caps.ts; their keys are refused here.
   */
  reserve(reservations: readonly CounterReservation[]): Promise<ReservationResult>;
  /** Gives back what `reserve` took when the spend did not happen. */
  release(reservations: readonly CounterReservation[]): Promise<void>;
  getCounter(counterKey: string): Promise<Counter | undefined>;
  /**
   * A cost-cap counter (`SIMCAP#`, `TURNCAP#`, `VALCAP#`, `TRANSCRIBE#`) as ops/cost-caps.ts keeps it:
   * read-only here (console gauges, world resets that keep real-time caps); expired rows read as absent.
   */
  getCapCounter(counterKey: string): Promise<CapCounter | undefined>;
}

export interface PendingMailState {
  readonly open: readonly PendingMail[];
  /** Open for more than 10 real minutes: they no longer keep the world busy. */
  readonly stale: readonly PendingMail[];
}

export interface WorldRuntimePort {
  getInstallerState(installerId: string): Promise<InstallerState | undefined>;
  getWorldState(clockId: string): Promise<WorldState | undefined>;
  /** A producer marks an event in flight for the installer and the world before `SendMessage`. */
  markInFlight(installerId: string, clockId: string, eventId: string): Promise<void>;
  /** The worker clears it when the event is done (or dead-lettered). */
  clearInFlight(installerId: string, clockId: string, eventId: string): Promise<void>;
  /** In flight for the world only (events with no installer: unknown numbers, supervisor keywords). */
  markWorldInFlight(clockId: string, eventId: string): Promise<void>;
  clearWorldInFlight(clockId: string, eventId: string): Promise<void>;
  setActiveWorkOrder(installerId: string, clockId: string, workOrderId: string | null, atSim?: string): Promise<InstallerState>;
  setProcessError(installerId: string, clockId: string, error: ProcessError | null): Promise<InstallerState>;
  /** Opens `MAIL#<mailId>`; a resend of the same mail reopens a closed mark and keeps an open one. */
  addPendingMail(clockId: string, mailId: string): Promise<PendingMail>;
  closePendingMail(clockId: string, mailId: string, eventType: string): Promise<PendingMail | undefined>;
  listPendingMail(clockId: string): Promise<PendingMailState>;
  /** Leases a number of a QA block; `false` when another run holds it. */
  acquireLease(kind: LeaseKind, n: number, holder: string): Promise<boolean>;
  releaseLease(kind: LeaseKind, n: number, holder: string): Promise<void>;
  createJoinCode(code: NewEntity<typeof JoinCode>): Promise<JoinCode>;
  getJoinCode(code: string): Promise<JoinCode | undefined>;
  /**
   * "ALTA <code>" from a real phone: consumes the one-use code and creates `PHONELEASE#<phoneHash>`
   * with `attribute_not_exists` (a phone bound to another world is a CONFLICT), in one transaction.
   */
  bindPhoneLease(code: string, phoneHash: string, bound?: Pick<PhoneLease, "phone" | "lastInboundAtReal">): Promise<PhoneLease>;
  /** The lease while it has not expired. */
  getPhoneLease(phoneHash: string): Promise<PhoneLease | undefined>;
  touchPhoneLease(phoneHash: string, lastInboundAtReal: string): Promise<PhoneLease>;
  deletePhoneLease(phoneHash: string): Promise<void>;
  /** Leases bound to a world (reset and the janitor delete them). */
  listPhoneLeases(clockId: string): Promise<PhoneLease[]>;
  createUpload(upload: NewEntity<typeof Upload>): Promise<Upload>;
  /** The upload while it has not expired. */
  getUpload(uploadId: string): Promise<Upload | undefined>;
  /** One use: CONFLICT when already used, NOT_FOUND when missing or expired. */
  useUpload(uploadId: string): Promise<Upload>;
  getLiveWorld(): Promise<LiveWorld | undefined>;
  /** CONFLICT when another world is already live (a single live world). */
  setLiveWorld(clockId: string, setBy: Actor): Promise<LiveWorld>;
  clearLiveWorld(clockId: string): Promise<void>;
  putTombstone(tombstone: NewEntity<typeof Tombstone>): Promise<Tombstone>;
  getTombstone(clockId: string, worldEpoch: number): Promise<Tombstone | undefined>;
  /** Idempotent: `false` when the probe already existed. */
  putProbe(probeId: string, detail?: JsonObject): Promise<boolean>;
  getProbe(probeId: string): Promise<Probe | undefined>;
  /** The console session that last acted in the world, while it has not expired (24 h). */
  getWorldSession(clockId: string): Promise<WorldSession | undefined>;
  /** Unconditional: never touches the clock, so it never races a move, a reset or a jump. */
  putWorldSession(session: NewEntity<typeof WorldSession>): Promise<WorldSession>;
  /** Faults of a `qa-*` world; always `undefined` for any other clock. */
  getFaults(clockId: string): Promise<Faults | undefined>;
  setFaults(faults: NewEntity<typeof Faults>): Promise<Faults>;
}

export interface KpiRef {
  readonly ispId: string;
  readonly source: MetricSource;
  readonly clockId: string;
  readonly workOrderId: string;
}

export interface KpiDelta {
  readonly counters?: Partial<Record<KpiCounter, number>>;
  readonly firstReplyLatencyMs?: number;
  readonly turnLatencyMs?: number;
  readonly costUsd?: number;
}

export interface MetricsPort {
  getKpi(ref: KpiRef): Promise<ConversationKpi | undefined>;
  putKpi(kpi: NewEntity<typeof ConversationKpi>): Promise<ConversationKpi>;
  /** Adds to a conversation's KPIs (creating the row with `agentMode`); retried on races. */
  addToKpi(ref: KpiRef & { readonly agentMode: ConversationKpi["agentMode"]; readonly runId?: string }, delta: KpiDelta): Promise<ConversationKpi>;
  listKpis(ispId: string, source?: MetricSource): Promise<ConversationKpi[]>;
  putEvalResult(result: NewEntity<typeof EvalResult>): Promise<EvalResult>;
  listEvalResults(ispId: string, runId: string, kind?: EvalResult["kind"]): Promise<EvalResult[]>;
}

export interface SeedLoadResult {
  readonly table: DomainTable;
  readonly written: number;
}

export interface SeedStore {
  /** Validates every row with its entity schema and codec (key and GSI attributes), then upserts in bulk. */
  loadItems(table: DomainTable, items: readonly Item[]): Promise<SeedLoadResult>;
  getItem(table: DomainTable, key: Key): Promise<Item | undefined>;
  deleteItems(table: DomainTable, keys: readonly Key[]): Promise<void>;
}
