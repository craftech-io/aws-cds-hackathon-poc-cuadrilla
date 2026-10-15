// `Runtime` table, turn and clock state (docs/architecture.md §5, §8, §9.1): sessions of agent turns,
// tool results of a turn, button nonces, world clocks, idempotency marks, counters (rate limits,
// caps, epochs) and the kill switch. Expiry is checked on read too: DynamoDB TTL deletes lazily.
// The world-scoped state (in-flight events, leases, codes, uploads…) is in domain/runtime-world.ts.
import { z } from "zod";
import {
  ClockId,
  ClockMode,
  InstallerId,
  IsoInstant,
  IspId,
  IspKind,
  KillScope,
  TurnTrigger,
  WaButtonAction,
  WorkOrderId,
} from "@cuadrilla/shared";
import { HexHash, JsonObject, defineEntity } from "./common";

// ---- Real-time TTLs (docs/architecture.md §5, `Runtime` row) -----------------------------------

export const RUNTIME_TTL_SECONDS = {
  session: 60 * 60,
  turn: 60 * 60,
  nonce: 7 * 24 * 60 * 60,
  idempotency: 7 * 24 * 60 * 60,
  counter: 48 * 60 * 60,
  lease: 48 * 60 * 60,
  tombstone: 48 * 60 * 60,
  pending: 48 * 60 * 60,
  probe: 48 * 60 * 60,
  phoneLease: 48 * 60 * 60,
  joinCode: 30 * 60,
  upload: 10 * 60,
  worldSession: 24 * 60 * 60,
} as const;

/** A pending email that got no SES event within this real time stops keeping its world busy. */
export const PENDING_MAIL_STALE_SECONDS = 10 * 60;

/**
 * `SESSION#<sessionId>`: everything a tool derives from its `sessionToken` (docs/tool-catalog.md,
 * Convenciones), never an id the model wrote. Same fields as `SessionRecord` of
 * services/session/session.ts, which reads and writes it through this port.
 */
export const Session = defineEntity("Session", {
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  turnId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  ispId: IspId,
  installerId: InstallerId,
  workOrderId: WorkOrderId.optional(),
  trigger: TurnTrigger,
  clockId: ClockId,
  eventAtSim: IsoInstant,
  sourceMessageId: z.string().min(1).max(256).optional(),
});
export type Session = z.infer<typeof Session>;

/** `TURN#<turnId>` · `META`: absent while the turn runs; `closedAtReal` makes its tokens invalid. */
export const Turn = defineEntity("Turn", {
  turnId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  clockId: ClockId.optional(),
  closedAtReal: IsoInstant.optional(),
  stopReason: z.string().max(64).optional(),
});
export type Turn = z.infer<typeof Turn>;

/** Redacted output of one tool call in a turn: the grounding source of G2 and of the fact check. */
export const TurnResult = defineEntity("TurnResult", {
  turnId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  tool: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  seq: z.int().min(1).max(999),
  output: JsonObject,
  atReal: IsoInstant,
});
export type TurnResult = z.infer<typeof TurnResult>;

/** What a button nonce points at (a case, an order, a checklist item, a message). */
export const NonceObject = z.object({
  kind: z.enum(["CASE", "WORK_ORDER", "ITEM", "MESSAGE", "DAY"]),
  id: z.string().min(1).max(200),
});
export type NonceObject = z.infer<typeof NonceObject>;

/** A button nonce, bound to the phone, the object and the action (7 days, docs/architecture-integrations.md §4.6). */
export const Nonce = defineEntity("Nonce", {
  nonce: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  clockId: ClockId,
  phoneHash: HexHash,
  personId: z.string().min(1).max(128),
  action: WaButtonAction,
  object: NonceObject,
  messageId: z.string().min(1).max(200).optional(),
  useCount: z.int().min(0).default(0),
  lastUsedAtReal: IsoInstant.optional(),
});
export type Nonce = z.infer<typeof Nonce>;

/** Who last opened the world from the console (one session per world, with a notice). */

/**
 * The demo clock of a world (ADR-0010). `PAUSED`: `simNow = pausedSimNow`. `RUNNING`:
 * `simNow = realNow + offsetMs` until `runningUntilReal`, then back to `PAUSED`.
 */
export const Clock = defineEntity("Clock", {
  clockId: ClockId,
  ispId: IspId,
  kind: IspKind,
  mode: ClockMode,
  offsetMs: z.int(),
  pausedSimNow: IsoInstant,
  worldEpoch: z.int().min(0),
  template: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
  runningUntilReal: IsoInstant.optional(),
  settings: JsonObject.optional(),
});
export type Clock = z.infer<typeof Clock>;

/** First sighting of an event (`IDEMP#<source>#<id>`, 7 days): a repeated event does nothing. */
export const Idempotency = defineEntity("Idempotency", {
  source: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  id: z.string().min(1).max(512),
  firstSeenAtReal: IsoInstant,
  result: JsonObject.optional(),
});
export type Idempotency = z.infer<typeof Idempotency>;

/**
 * Families of plain counters: business rate limits (`RATE#`), replies to unknown numbers
 * (`UNKNOWN#GLOBAL#`), scene jumps (`JUMP#`), world epochs (`COUNTER#EPOCH#`) and named counters.
 * Cost caps (`SIMCAP#`, `TURNCAP#`, `VALCAP#`, `TRANSCRIBE#`) are `CapCounter` rows of
 * ops/cost-caps.ts (`reserve_cost`), the one module that reserves them.
 */
export const CounterKind = z.enum(["RATE", "UNKNOWN", "JUMP", "EPOCH", "COUNTER"]);
export type CounterKind = z.infer<typeof CounterKind>;

/** Prefixes of the cost-cap ledgers; plain counters never use them. */
export const CAP_KEY_PREFIXES = ["SIMCAP#", "TURNCAP#", "VALCAP#", "TRANSCRIBE#"] as const;

/** An atomic counter with an optional ceiling (conditional ADD). */
export const Counter = defineEntity("Counter", {
  counterKey: z.string().min(1).max(512),
  kind: CounterKind,
  count: z.number(),
});
export type Counter = z.infer<typeof Counter>;

/**
 * A cost-cap counter as ops/dynamo-runtime-store.ts writes it (ADR-0019): `used` against `capLimit`
 * for one ledger, resource and real period. No `version`: it only moves by conditional ADDs.
 */
export const CapCounter = z.object({
  entity: z.literal("CapCounter"),
  used: z.number(),
  ledger: z.enum(["SIMULATOR", "OPERATOR", "GLOBAL"]),
  resource: z.enum(["turns", "validations", "transcribe", "emails"]),
  period: z.enum(["HOUR", "DAY"]),
  capLimit: z.int().min(0),
  createdAt: IsoInstant.optional(),
  updatedAt: IsoInstant.optional(),
  expiresAt: z.int().min(0).optional(),
});
export type CapCounter = z.infer<typeof CapCounter>;

/**
 * The runtime kill switch as ops/kill-switch.ts writes it (ADR-0019): `KILL#<ALL|SIMULATOR|AGENT>`
 * or `KILL#AGENT#<clockId>`, a whole-item `PutItem`, no `version`.
 */
export const KillSwitch = z.object({
  entity: z.literal("KillSwitch"),
  scope: KillScope,
  clockId: ClockId.optional(),
  state: z.enum(["on", "off"]),
  setBy: z.enum(["OPERATOR", "QA"]),
  setAtReal: IsoInstant,
  reason: z.string().trim().min(1).max(200).optional(),
  updatedAt: IsoInstant.optional(),
  expiresAt: z.int().min(0).optional(),
});
export type KillSwitch = z.infer<typeof KillSwitch>;
