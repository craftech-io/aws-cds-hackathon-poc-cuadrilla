// The QaDriver's `signup.start` (ADR-0025 §7, `SC-20`), run by the `Bff`, which owns the writes of a start:
// the lead (`BFF_LEADS_GRANT`, infra/leads-spec.ts) and the counters of the run (`SIGNUP#qa-<runId>#…`,
// signup/limits.ts). The QaDriver's role is denied both by IAM (it holds LEADS_READ only and its `Runtime`
// writes are fenced by key, infra/qa-driver-fence.ts), so it invokes this Lambda directly
// (`lambda:InvokeFunction`, never the Function URL) with `{op: QA_SIGNUP_START, runId, correlationId, form}`.
//
// A request of the Function URL always carries `requestContext` (payload format 2.0) and only its body and
// headers come from the viewer, so no request reaches this path: only an IAM principal allowed to invoke the
// function. Even then, the form's address must be a QA address (`success+qa-…@simulator.amazonses.com`):
// the run's own counters never open room for any other lead. The start runs through the real `appRouter`
// procedure with the run's context (`createQaPublicContext`), and the answer is the procedure's result or
// its refusal as `{code, reason, message}`, never a stack or the input.
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ToolFailureSchema, toToolFailure } from "@cuadrilla/shared";
import { leadOriginOf } from "../leads/keys";

export const QA_SIGNUP_START = "QA_SIGNUP_START";

export const QaSignupStartRequest = z
  .object({
    op: z.literal(QA_SIGNUP_START),
    /** The run and its optional sub-scope (`812-1`, `812-1-s8`): the keys of the run's counters. */
    runId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    correlationId: z.string().min(1).max(128),
    form: z.object({ email: z.string().max(254) }).loose(),
  })
  .strict();
export type QaSignupStartRequest = z.infer<typeof QaSignupStartRequest>;

const QaSignupStarted = z.object({ ticket: z.string().min(1), username: z.string().min(1), expiresAt: z.iso.datetime() }).strict();
export type QaSignupStarted = z.infer<typeof QaSignupStarted>;

/** What the invocation answers: the procedure's result, or its refusal (never a stack, never the input). */
export const QaSeamAnswer = z.union([z.object({ ok: z.literal(true), result: QaSignupStarted }).strict(), ToolFailureSchema]);
export type QaSeamAnswer = z.infer<typeof QaSeamAnswer>;

/** A direct invocation of the QA seam: never a request of the Function URL (it carries `requestContext`). */
export function isQaSeamEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  return (event as { op?: unknown }).op === QA_SIGNUP_START && !("requestContext" in event) && !("rawPath" in event);
}

function refusal(error: unknown): QaSeamAnswer {
  return toToolFailure(error instanceof TRPCError && error.cause !== undefined ? error.cause : error);
}

/** `start` runs the `appRouter`'s `signup.start` with the run's context; the caller builds it (handler.ts). */
export async function handleQaSeam(event: unknown, start: (request: QaSignupStartRequest) => Promise<QaSignupStarted>): Promise<QaSeamAnswer> {
  const parsed = QaSignupStartRequest.safeParse(event);
  if (!parsed.success) return { ok: false, error: { code: "INVALID", message: "QA_SIGNUP_START takes {op, runId, correlationId, form}", reason: "VALIDATION" } };
  let origin;
  try {
    origin = leadOriginOf(parsed.data.form.email);
  } catch {
    origin = "WEB";
  }
  if (origin !== "QA") return { ok: false, error: { code: "FORBIDDEN", message: "the QA seam starts sign-ups of QA addresses only", reason: "NOT_A_QA_ADDRESS" } };
  try {
    return { ok: true, result: await start(parsed.data) };
  } catch (error) {
    return refusal(error);
  }
}
