// Who is invoking a handler (docs/tool-catalog.md, Convenciones). Through the Gateway the principal is
// the Harness and its identity is the `sessionToken` the worker signed for the turn, never an id the
// model wrote; outside the Gateway it is an explicit `caller`. `caller` does not authenticate (a
// Lambda cannot see the role that invoked it): the fence is each Lambda's resource policy plus the
// `sessionToken` XOR `caller` union below (`LAM-CALLER`); `createToolHandler` also rejects `caller`
// when the invocation context carries the AgentCore Gateway keys.
import { z } from "zod";
import { ClockId, JUDGE_TEST_CLOCK_ID, isQaReachableClock, parseClockId } from "./clock-ids";
import { ConsoleRole } from "./enums";
import { ConsoleUserId, IspId } from "./ids";

export const CallerKind = z.enum(["WORKER", "CHANNEL", "CONSOLE", "QA", "SCHEDULER"]);
export type CallerKind = z.infer<typeof CallerKind>;

/** What invoked a handler: the Harness through the Gateway (by `sessionToken`) or a direct caller. */
export type PrincipalKind = "HARNESS" | CallerKind;

/** Kinds that always act inside one world (the scheduler also runs sweeps across worlds). */
const WORLD_BOUND_KINDS: ReadonlySet<CallerKind> = new Set<CallerKind>(["WORKER", "CHANNEL", "CONSOLE", "QA"]);
/** Kinds that carry a console user: a person of the operator, or a principal the `QaDriver` built. */
const USER_KINDS: ReadonlySet<CallerKind> = new Set<CallerKind>(["CONSOLE", "QA"]);

export const Caller = z
  .object({
    kind: CallerKind,
    ispId: IspId.optional(),
    userId: ConsoleUserId.optional(),
    role: ConsoleRole.optional(),
    /** Queue, channel or feed event the call belongs to (idempotency and correlation). */
    eventId: z.string().min(1).max(256).optional(),
    clockId: ClockId.optional(),
  })
  .strict()
  .superRefine((caller, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const world = caller.clockId === undefined ? undefined : parseClockId(caller.clockId);
    if (WORLD_BOUND_KINDS.has(caller.kind)) {
      if (caller.ispId === undefined) issue("ispId", `${caller.kind} caller needs its operator`);
      if (caller.clockId === undefined) issue("clockId", `${caller.kind} caller needs its world`);
    }
    if (caller.ispId !== undefined && world !== undefined && world.ispId !== caller.ispId) {
      issue("ispId", "the operator is not the one of the world");
    }
    if (!USER_KINDS.has(caller.kind)) {
      if (caller.userId !== undefined) issue("userId", `${caller.kind} caller has no console user`);
      if (caller.role !== undefined) issue("role", `${caller.kind} caller has no console role`);
    }
    if (caller.kind === "CONSOLE") {
      if (caller.userId === undefined) issue("userId", "CONSOLE caller needs its user");
      if (caller.role === undefined) issue("role", "CONSOLE caller needs its role");
      // A judge acts only inside a judge world, and a judge world has only judges.
      if (caller.role !== undefined && world !== undefined && (caller.role === "JUDGE") !== (world.kind === "JUDGE")) {
        issue("role", "JUDGE is the role of a judge world and only of a judge world");
      }
    }
    if (caller.kind === "QA") {
      if (caller.clockId !== undefined && !isQaReachableClock(caller.clockId)) issue("clockId", "QA acts only on qa-*, eval-* and JUDGE#isp-judge-test");
      if (caller.userId !== undefined && !caller.userId.startsWith("usr-qa-")) issue("userId", "QA principals are usr-qa-*");
      if (caller.role === "JUDGE" && caller.clockId !== JUDGE_TEST_CLOCK_ID) issue("role", "the QA judge principal is bound to JUDGE#isp-judge-test");
      if (caller.clockId === JUDGE_TEST_CLOCK_ID && caller.role !== undefined && caller.role !== "JUDGE") issue("role", "QA acts on JUDGE#isp-judge-test only as JUDGE");
    }
  });
export type Caller = z.infer<typeof Caller>;

// `<sessionId>.<turnId>.<exp>.<HMAC-SHA256 base64url>`; `exp` is epoch seconds, at most 15 min ahead.
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,64}\.\d{1,12}\.[A-Za-z0-9_-]{43}$/;
export const SESSION_TOKEN_MAX_TTL_SECONDS = 15 * 60;

export const SessionToken = z.string().regex(SESSION_TOKEN_PATTERN, "malformed session token");
export type SessionToken = z.infer<typeof SessionToken>;

export interface SessionTokenParts {
  readonly sessionId: string;
  readonly turnId: string;
  /** Epoch seconds. */
  readonly exp: number;
  readonly signature: string;
}

/** Splits without verifying: the signature needs the `session` subkey and is checked in the bff. */
export function splitSessionToken(token: string): SessionTokenParts {
  const [sessionId = "", turnId = "", exp = "0", signature = ""] = SessionToken.parse(token).split(".");
  return { sessionId, turnId, exp: Number(exp), signature };
}

/** Tokens live in real time; the caller injects `nowMs` (never the simulated clock of a world). */
export function isSessionTokenExpired(token: string, nowMs: number): boolean {
  return splitSessionToken(token).exp * 1000 <= nowMs;
}

/**
 * Every handler input carries exactly one of the two. The objects are not strict so the tool's own
 * fields pass through here; each tool schema adds them and applies `.strict()` (`LAM-STRICT`).
 */
export const PrincipalInput = z.union([
  z.object({ sessionToken: SessionToken, caller: z.undefined().optional() }),
  z.object({ caller: Caller, sessionToken: z.undefined().optional() }),
]);
export type PrincipalInput = z.infer<typeof PrincipalInput>;

export function principalKind(input: PrincipalInput): PrincipalKind {
  return input.sessionToken !== undefined ? "HARNESS" : input.caller.kind;
}
