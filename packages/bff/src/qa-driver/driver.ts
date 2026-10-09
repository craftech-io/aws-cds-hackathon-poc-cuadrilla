// The `QaDriver` (ADR-0007, docs/test-plan.md §4): one Lambda with a closed set of actions, invoked only by
// the bootstrap's `qa-runner` role. Every request goes through the same steps:
//
//   1. envelope and input parsed with zod (`.strict()`: an unknown key is INVALID);
//   2. the world resolved from stored rows and fenced (guard.ts); anything else is FORBIDDEN before a
//      byte is written;
//   3. a changing action already done under the same idempotency key answers its first result
//      (`replayed: true`); ids derive from the key (contract.ts), so even a lost answer retried twice
//      produces one effect. The mark keeps the action and a hash of the input: the same key with another
//      action or input is CONFLICT `IDEMPOTENCY_KEY_REUSED` and nothing runs;
//   4. the action runs; its failure comes back as `{ ok: false, error }`, never as a thrown error.
import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ToolError, toToolFailure } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import type { Logger } from "../lib/log";
import { QA_REASON, type QaActionName, QaRequest, type QaResponse } from "./contract";
import { ACTION_INPUTS } from "./contract-inputs";
import { type GuardLookups, type Scope, guard } from "./guard";

/** Source of the driver's idempotency marks (`Runtime/IDEMP#QA#<key>`). */
export const QA_IDEMPOTENCY_SOURCE = "QA";

/** A result larger than this is not kept for replay: the action runs again (its effects are idempotent by key). */
export const MAX_REPLAY_BYTES = 64 * 1024;

/** What every action handler receives besides its input. */
export interface ActionContext {
  readonly idempotencyKey: string;
  readonly scope: Scope;
  readonly log: Logger;
  /** Real time. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

export type ActionHandler = (input: unknown, ctx: ActionContext) => Promise<unknown>;
export type ActionHandlers = Readonly<Record<QaActionName, ActionHandler>>;

export interface QaDriverDeps {
  readonly data: Pick<Connector, "runtime">;
  readonly lookups: GuardLookups;
  readonly handlers: ActionHandlers;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly loggerFor: (correlationId: string) => Logger;
}

const TRPC_TO_CODE: Readonly<Partial<Record<TRPCError["code"], z.infer<typeof ErrorCodeShape>>>> = {
  UNAUTHORIZED: "FORBIDDEN",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  BAD_REQUEST: "INVALID",
  CONFLICT: "CONFLICT",
  TOO_MANY_REQUESTS: "CAP_REACHED",
  PRECONDITION_FAILED: "CONFLICT",
  SERVICE_UNAVAILABLE: "UNAVAILABLE",
};
const ErrorCodeShape = z.enum(["NOT_FOUND", "FORBIDDEN", "INVALID", "CONFLICT", "UNAVAILABLE", "CAP_REACHED"]);

function reasonOfCause(cause: unknown): string | undefined {
  if (cause instanceof ToolError) return cause.reason ?? cause.code;
  const reason = (cause as { reason?: unknown } | undefined)?.reason;
  return typeof reason === "string" ? reason : undefined;
}

/** A failure as the runner reads it: the code, a message without internals and the reason. */
export function failureOf(error: unknown): QaResponse {
  if (error instanceof TRPCError) {
    if (error.cause instanceof ToolError) return { ok: false, error: error.cause.toFailure().error };
    const reason = reasonOfCause(error.cause);
    return { ok: false, error: { code: TRPC_TO_CODE[error.code] ?? "UNAVAILABLE", message: `${error.code}: ${error.message}`, ...(reason === undefined ? {} : { reason }) } };
  }
  if (error instanceof z.ZodError) {
    const where = error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`).join("; ");
    return { ok: false, error: { code: "INVALID", message: `invalid input: ${where}`, reason: "VALIDATION" } };
  }
  return { ok: false, error: toToolFailure(error).error };
}

/** What a mark is bound to: the action and its parsed input. */
export function callDigest(action: QaActionName, input: unknown): string {
  return createHash("sha256").update(JSON.stringify({ action, input: input ?? null }), "utf8").digest("hex");
}

type Replay = { readonly found: false } | { readonly found: true; readonly result: unknown };

async function replayOf(data: QaDriverDeps["data"], key: string, digest: string): Promise<Replay> {
  const stored = (await data.runtime.getIdempotency(QA_IDEMPOTENCY_SOURCE, key))?.result;
  if (stored === undefined) return { found: false };
  if (stored.digest !== digest) throw new ToolError("CONFLICT", "this idempotency key was used by another action or input", QA_REASON.IDEMPOTENCY_KEY_REUSED);
  if (stored.oversize === true) return { found: false };
  return { found: true, result: stored.value ?? null };
}

async function remember(data: QaDriverDeps["data"], key: string, digest: string, result: unknown): Promise<void> {
  const json = JSON.stringify(result ?? null);
  const stored = json.length > MAX_REPLAY_BYTES ? { digest, oversize: true } : { digest, value: JSON.parse(json) as unknown };
  // A concurrent twin of this call may have written first: its effect is the same one (ids derive from the key).
  await data.runtime.claimIdempotency(QA_IDEMPOTENCY_SOURCE, key, stored);
}

export function createQaDriver(deps: QaDriverDeps) {
  return async function run(raw: unknown): Promise<QaResponse> {
    const started = deps.now().getTime();
    const envelope = QaRequest.safeParse(raw);
    if (!envelope.success) return failureOf(envelope.error);
    const { action, idempotencyKey } = envelope.data;
    const log = deps.loggerFor(idempotencyKey.replaceAll("/", "-").slice(0, 64)).child({ service: "qa-driver", action });
    try {
      const input: unknown = ACTION_INPUTS[action].parse(envelope.data.input ?? {});
      const scope = await guard(action, input, deps.lookups);
      const digest = scope.mutating ? callDigest(action, input) : "";
      if (scope.mutating) {
        const replay = await replayOf(deps.data, idempotencyKey, digest);
        if (replay.found) {
          log.info("qa_driver.replayed", { clockId: scope.clockId ?? null });
          return { ok: true, replayed: true, result: replay.result };
        }
      }
      const ctx: ActionContext = { idempotencyKey, scope, log, now: deps.now, sleep: deps.sleep };
      const result = await deps.handlers[action](input, ctx);
      if (scope.mutating) await remember(deps.data, idempotencyKey, digest, result);
      log.info("qa_driver.done", { clockId: scope.clockId ?? null, ms: deps.now().getTime() - started });
      return { ok: true, replayed: false, result: result ?? null };
    } catch (error) {
      const failure = failureOf(error);
      const fields = { code: failure.ok ? null : failure.error.code, reason: failure.ok ? null : (failure.error.reason ?? null), ms: deps.now().getTime() - started };
      if (error instanceof ToolError || error instanceof z.ZodError || error instanceof TRPCError) log.warn("qa_driver.refused", fields);
      else log.error("qa_driver.failed", { ...fields, errorName: error instanceof Error ? error.name : "unknown" });
      return failure;
    }
  };
}

export type QaDriver = ReturnType<typeof createQaDriver>;
