// Contract of the `QaDriver` Lambda (docs/tool-catalog.md "Acciones del QaDriver", docs/test-plan.md §4,
// ADR-0007), shared by the Lambda and the scenario runner (scripts/scenarios/): the request envelope, the
// idempotency key every action carries, the result envelope and the ids derived from the key, so retrying
// a step never duplicates an effect.
//
//   request   { action, idempotencyKey: "<runId>/<scenario>/<step>[/<label>]", input }
//   result    { ok: true, replayed, result } | { ok: false, error: { code, message, reason? } }
//
// This module imports only zod and the shared package: the runner reads it without the Lambda's code.
// The inputs of every action are in contract-inputs.ts.
import { createHash } from "node:crypto";
import { z } from "zod";
import { ErrorCode } from "@cuadrilla/shared";

export const QA_ACTIONS = [
  // Worlds, quiescence and the clock
  "world.create",
  "world.destroy",
  "world.settle",
  "installer.settle",
  "case.open",
  "clock.advance",
  "clock.advanceTo",
  "clock.advanceToNext",
  "clock.forceCaseTimeout",
  "clock.fireTimer",
  "clock.fireDayStart",
  "clock.unfreeze",
  "clock.freeze",
  // Channels
  "wa.inbound",
  "wa.publishForeign",
  "probe.foreign",
  "mail.outcome",
  "nonce.expire",
  "lease.setLastInboundAtReal",
  // The simulated systems and the faults of a world
  "network.setBehaviour",
  "network.fix",
  "network.setFaults",
  "knowledge.setFaults",
  "transcribe.setFaults",
  "validator.setFaults",
  "kill.set",
  "dispatch.reschedule",
  "dispatch.reassign",
  "dispatch.cancel",
  // The console, the tools and the evaluation
  "console",
  "tool.invoke",
  "eval.runQuestions",
  "eval.runPhotos",
  // Failures, the DLQ and the policy
  "fence.probe",
  "guardrail.probe",
  "turn.forceFailure",
  "event.poison",
  "dlq.find",
  "dlq.delete",
  "alarm.history",
  "schedule.fireStale",
  // Reads
  "memory.inspect",
  "snapshot",
  "policyAudit.run",
  "metrics.get",
  "probe.mocks",
  "kb.probe",
  "waf.probe",
  "auth.probe",
  // The QA seam of the own sign-up (ADR-0025 §7)
  "signup.start",
  "auth.signUp",
  "auth.confirmQaSignup",
  "auth.qaLogin",
  "auth.cleanupQaSignup",
  "guest.forceExpire",
  "guest.capsOverride",
  "leads.get",
] as const;
export const QaActionName = z.enum(QA_ACTIONS);
export type QaActionName = z.infer<typeof QaActionName>;

/**
 * Actions that only read (or only wait): never remembered under their key (a retry reads again). Every
 * other action changes something and replays its first answer when its key comes back.
 */
export const READ_ONLY_ACTIONS: ReadonlySet<QaActionName> = new Set<QaActionName>([
  "world.settle",
  "installer.settle",
  "probe.foreign",
  "mail.outcome",
  "fence.probe",
  "guardrail.probe",
  "dlq.find",
  "alarm.history",
  "memory.inspect",
  "snapshot",
  "metrics.get",
  "probe.mocks",
  "kb.probe",
  "waf.probe",
  "auth.probe",
  "leads.get",
]);

/**
 * `<github run id>-<attempt>` in CI, optionally `-r<n>` for the n-th of the three runs of the gate
 * (docs/test-plan.md §1), or `local-<ulid in lower case>` from a laptop (§4.4). Lower case: it ends up in
 * clock ids, person ids and the addresses of the simulator.
 */
export const RunId = z.string().regex(/^(?:\d{1,20}-\d{1,3}(?:-r\d)?|local-[0-9a-hjkmnp-tv-z]{26})$/, "expected <run id>-<attempt>[-r<n>] or local-<ulid>");
export type RunId = z.infer<typeof RunId>;

/** Scenario slug of clocks and keys: `sc-04`, `sc-04-dup`; the evaluation's are `EV-01`, `EV-02`. */
export const ScenarioSlug = z.string().regex(/^(?:sc-\d{2}(?:-[a-z0-9]{1,8})?|EV-0[12])$/, "expected sc-<nn>[-<suffix>] or EV-0n");
export type ScenarioSlug = z.infer<typeof ScenarioSlug>;

const KEY = /^(?:\d{1,20}-\d{1,3}(?:-r\d)?|local-[0-9a-hjkmnp-tv-z]{26})\/(?:sc-\d{2}(?:-[a-z0-9]{1,8})?|EV-0[12])\/[0-9A-Za-z.]{1,8}(?:\/[a-z0-9][a-z0-9.-]{0,31})?$/;

/** `<runId>/<scenario>/<step or part>` plus an optional label per call inside the step. */
export const IdempotencyKey = z.string().max(160).regex(KEY, "expected <runId>/<scenario>/<step>[/<label>]");
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

export function idempotencyKeyOf(parts: { readonly runId: string; readonly scenario: string; readonly step: string; readonly label?: string }): IdempotencyKey {
  const base = `${parts.runId}/${parts.scenario}/${parts.step}`;
  return IdempotencyKey.parse(parts.label === undefined ? base : `${base}/${parts.label}`);
}

/** The run of a key (`812-1/sc-04/3/m1` → `812-1`). */
export function runIdOfKey(key: string): string {
  return key.slice(0, key.indexOf("/"));
}

/** The clock of a scenario's world: `qa-<runId>-<slug>` (docs/test-plan.md §4.2). */
export function scenarioClockId(runId: string, slug: string): string {
  return `qa-${RunId.parse(runId)}-${ScenarioSlug.parse(slug)}`;
}

export const QaRequest = z
  .object({
    action: QaActionName,
    idempotencyKey: IdempotencyKey,
    input: z.unknown().optional(),
  })
  .strict();
export type QaRequest = z.infer<typeof QaRequest>;

export const QaError = z.object({ code: ErrorCode, message: z.string(), reason: z.string().optional() });
export type QaError = z.infer<typeof QaError>;

export type QaResponse<T = unknown> = { readonly ok: true; readonly replayed: boolean; readonly result: T } | { readonly ok: false; readonly error: QaError };

export const QaResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), replayed: z.boolean(), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: QaError }),
]);

/** Reasons the driver answers with besides the domain's own. */
export const QA_REASON = {
  /** ADR-0007: operator not of QA type, clock outside the allowed set, action outside a closed list. */
  QA_FENCE: "QA_FENCE",
  /** The seam of the own sign-up: the address Cognito holds for the user is not a QA address. */
  NOT_A_QA_ADDRESS: "NOT_A_QA_ADDRESS",
  /** What the action drives is not deployed with this function: BLOCKED, never a pass. */
  NOT_WIRED: "NOT_WIRED",
  /** `installer.settle` / `world.settle` ran out of time with something pending. */
  NOT_SETTLED: "NOT_SETTLED",
  /** `mail.outcome` saw no event of SES in time. */
  NO_OUTCOME: "NO_OUTCOME",
  /** `probe.foreign` found no probe in time. */
  NO_PROBE: "NO_PROBE",
  /** `memory.inspect` with `waitForExtraction` ran out of time; the message names the strategy. */
  EXTRACTION_INCOMPLETE: "EXTRACTION_INCOMPLETE",
  /** The key was used by a call with another action or input: nothing ran (driver.ts). */
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
} as const;

// ---- Ids derived from the idempotency key (docs/test-plan.md §4.4) --------------------------------

function digest(key: string): string {
  return createHash("sha256").update(IdempotencyKey.parse(key), "utf8").digest("hex");
}

/** Event id of an event the driver enqueues (`event.poison`, `case.open`, `schedule.fireStale`): `qa-<40 hex>`. */
export function qaEventId(key: string): string {
  return `qa-${digest(key).slice(0, 40)}`;
}

/** Event id of the foreign event `wa.publishForeign` publishes (its SNS message id is SNS's own). */
export function qaForeignId(key: string): string {
  return `qa-foreign-${digest(key).slice(0, 32)}`;
}

/** Upload id of a media the driver hands to the simulated channel (`wa.inbound`). */
export function qaUploadId(key: string): string {
  return `qa-${digest(key).slice(0, 40)}`;
}
