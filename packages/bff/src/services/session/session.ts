// The session of a turn (docs/architecture.md §9.1, docs/tool-catalog.md "Sesión"). The worker opens
// one per turn: it stores `Runtime/SESSION#<sessionId>` with the identity of the turn and signs
// `sessionToken = <sessionId>.<turnId>.<exp>.<HMAC-SHA256 base64url>` with the `session` subkey,
// valid for at most 15 real minutes. Every Gateway tool resolves the token here and derives
// operator, installer, work order, world, event time and source message from the stored session,
// never from the model's input (`LAM-SCOPE`); a token of a closed turn is refused even before it
// expires.
import { z } from "zod";
import {
  ClockId,
  ERROR_REASON,
  InstallerId,
  IsoInstant,
  IspId,
  SESSION_TOKEN_MAX_TTL_SECONDS,
  SESSION_TOKEN_PATTERN,
  type SessionTokenParts,
  ToolError,
  TurnTrigger,
  WorkOrderId,
  ispIdOfClock,
  splitSessionToken,
} from "@cuadrilla/shared";
import { type SecretKey, hmacSha256Base64Url, safeEqual, ulid } from "../../lib/crypto";

/** Session and turn ids: 1 to 64 characters of `[A-Za-z0-9_-]` (ULIDs in practice). */
export const SessionPartId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "expected a session or turn id");

/** TTL of `Runtime/SESSION#` (docs/architecture.md §5): an hour, well past the 15 minutes of its token. */
export const SESSION_TTL_SECONDS = 3_600;

/**
 * `Runtime/SESSION#<sessionId>`: what a tool is allowed to act on during the turn. Reading strips
 * the item's own attributes (keys, TTL, version). `workOrderId` is absent in a turn without an
 * active order; `sourceMessageId` in a turn no message opened (a case closed from the console).
 */
export const SessionRecord = z
  .object({
    sessionId: SessionPartId,
    turnId: SessionPartId,
    ispId: IspId,
    installerId: InstallerId,
    workOrderId: WorkOrderId.optional(),
    trigger: TurnTrigger,
    clockId: ClockId,
    /** Simulated instant of the event that opened the turn: the "now" of every rule in it. */
    eventAtSim: IsoInstant,
    sourceMessageId: z.string().min(1).max(256).optional(),
  })
  .superRefine((record, ctx) => {
    if (ispIdOfClock(record.clockId) !== record.ispId) ctx.addIssue({ code: "custom", path: ["ispId"], message: "the operator is not the one of the world" });
  });
export type SessionRecord = z.infer<typeof SessionRecord>;

/** Tolerance for clocks of different containers when checking how far away `exp` is. */
export const SESSION_CLOCK_SKEW_SECONDS = 60;

function signingInput(sessionId: string, turnId: string, exp: number): string {
  return `${sessionId}.${turnId}.${exp}`;
}

export interface IssuedSessionToken {
  readonly token: string;
  /** Epoch seconds. */
  readonly exp: number;
}

/**
 * Signs a token for one turn. `sessionKey` is the `session` subkey (`subkey("session")`), `nowMs`
 * real time: tokens, like logins and presigned URLs, never follow a world's simulated clock.
 */
export function issueSessionToken(
  sessionKey: SecretKey,
  input: { readonly sessionId: string; readonly turnId: string; readonly ttlSeconds?: number },
  nowMs: number,
): IssuedSessionToken {
  const sessionId = SessionPartId.parse(input.sessionId);
  const turnId = SessionPartId.parse(input.turnId);
  const ttlSeconds = input.ttlSeconds ?? SESSION_TOKEN_MAX_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > SESSION_TOKEN_MAX_TTL_SECONDS) {
    throw new RangeError(`a session token lives 1 to ${SESSION_TOKEN_MAX_TTL_SECONDS} seconds, got ${ttlSeconds}`);
  }
  if (!Number.isFinite(nowMs)) throw new RangeError("invalid nowMs");
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const token = `${signingInput(sessionId, turnId, exp)}.${hmacSha256Base64Url(sessionKey, signingInput(sessionId, turnId, exp))}`;
  return { token, exp };
}

function invalid(message: string): ToolError {
  return new ToolError("FORBIDDEN", message, ERROR_REASON.SESSION_INVALID);
}

function expired(message: string): ToolError {
  return new ToolError("FORBIDDEN", message, ERROR_REASON.SESSION_EXPIRED);
}

/**
 * Checks shape, signature (constant time) and expiry of a token and returns its parts. Throws a
 * `ToolError` FORBIDDEN with reason `SESSION_INVALID` or `SESSION_EXPIRED`; the message never
 * repeats the token.
 */
export function verifySessionToken(sessionKey: SecretKey, token: unknown, nowMs: number): SessionTokenParts {
  if (typeof token !== "string" || !SESSION_TOKEN_PATTERN.test(token)) throw invalid("malformed session token");
  const parts = splitSessionToken(token);
  const expected = hmacSha256Base64Url(sessionKey, signingInput(parts.sessionId, parts.turnId, parts.exp));
  if (!safeEqual(parts.signature, expected)) throw invalid("session token signature does not verify");
  const nowSeconds = Math.floor(nowMs / 1000);
  if (parts.exp <= nowSeconds) throw expired("session token expired");
  if (parts.exp > nowSeconds + SESSION_TOKEN_MAX_TTL_SECONDS + SESSION_CLOCK_SKEW_SECONDS) throw invalid("session token outlives the 15-minute limit");
  return parts;
}

/** `Runtime/TURN#<turnId>` META as far as a session cares: a turn with `closedAtReal` is over. */
export const TurnState = z.object({ closedAtReal: IsoInstant.optional() });
export type TurnState = z.infer<typeof TurnState>;

export interface SessionStore {
  /** `Runtime/SESSION#<sessionId>`, or `undefined` when it does not exist (or its TTL removed it). */
  getSession(sessionId: string): Promise<unknown>;
  /** `Runtime/TURN#<turnId>` META; `undefined` while the worker has not written it (the turn is open). */
  getTurn(turnId: string): Promise<unknown>;
}

export interface ResolvedSession extends SessionRecord {
  /** Epoch seconds the token stops being valid. */
  readonly exp: number;
}

/**
 * Everything a Gateway tool knows about whom it acts for: verifies the token, loads the stored
 * session of the same turn and refuses a closed turn.
 */
export async function resolveSession(sessionKey: SecretKey, token: unknown, store: SessionStore, nowMs: number): Promise<ResolvedSession> {
  const parts = verifySessionToken(sessionKey, token, nowMs);
  const stored = SessionRecord.safeParse(await store.getSession(parts.sessionId));
  if (!stored.success) throw invalid("session not found");
  if (stored.data.sessionId !== parts.sessionId || stored.data.turnId !== parts.turnId) throw invalid("session belongs to another turn");
  const turn = await store.getTurn(parts.turnId);
  if (turn !== undefined) {
    const state = TurnState.safeParse(turn);
    if (!state.success) throw invalid("turn state is unreadable");
    if (state.data.closedAtReal !== undefined) throw expired("the turn of this session is closed");
  }
  return { ...stored.data, exp: parts.exp };
}

export interface SessionWriter {
  /** Writes `Runtime/SESSION#<sessionId>` with its TTL (`expiresAt`, epoch seconds), never overwriting one. */
  putSession(record: SessionRecord, expiresAt: number): Promise<void>;
}

export interface OpenedSession {
  readonly record: SessionRecord;
  readonly token: string;
  /** Epoch seconds the token stops being valid. */
  readonly exp: number;
}

/**
 * Opens the session of a turn: a new session id (real time orders it), the stored record and its
 * signed token. The worker calls it once per turn and puts the token in the envelope.
 */
export async function openSession(
  deps: { readonly sessionKey: SecretKey; readonly store: SessionWriter; readonly nowMs: number },
  input: Omit<SessionRecord, "sessionId"> & { readonly ttlSeconds?: number },
): Promise<OpenedSession> {
  const { ttlSeconds, ...fields } = input;
  const record = SessionRecord.parse({ ...fields, sessionId: ulid(deps.nowMs) });
  const issued = issueSessionToken(deps.sessionKey, { sessionId: record.sessionId, turnId: record.turnId, ttlSeconds }, deps.nowMs);
  await deps.store.putSession(record, Math.floor(deps.nowMs / 1000) + SESSION_TTL_SECONDS);
  return { record, token: issued.token, exp: issued.exp };
}
