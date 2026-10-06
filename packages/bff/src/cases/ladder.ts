// The escalation ladder (docs/design-brief.md §5.8, `advance_ladder`), deterministic: a case copies
// the shift roster in force when it opens and climbs PRIMARY → SECONDARY → ZONE_CHIEF. Each rung is
// notified (template → plan B → skip, notify.ts); a notified supervisor's rung arms
// `TIMER#CASE_TIMEOUT` with the case's `rungVersion` and, when it fires (or the supervisor taps
// "No puedo"), the case moves on. On ZONE_CHIEF the email goes out and the case stays OPEN in the
// console, where any supervisor can take it; no more timers. A timeout or a tap that carries an old
// `rungVersion`, or reaches a case that is no longer OPEN, is ignored and audited (`LAD-STALE`).
//
// SAFETY cases alert the zone chief by email from the start, in parallel with the first supervisor;
// CERTIFICATE_UNDELIVERED cases live only in the console's inbox (no WhatsApp, `LAD-CONSOLE-ONLY`).
import { ConnectorError, Rung, type TimerFiredBy } from "@cuadrilla/shared";
import { esMX } from "../copy/es-MX";
import type { Case, LadderEntry } from "../domain/cases";
import type { Person } from "../domain/people";
import type { WorkOrder } from "../domain/work-orders";
import type { CaseDeps } from "./ports";
import { type RungAttempt, type RungContext, alertZoneChief, noticeInstaller, notifyRung } from "./notify";
import { caseReasonText } from "./summary";
import { armRungTimeout, cancelRungTimeouts } from "./timeouts";

export type LadderCause =
  | { readonly kind: "OPEN" }
  | { readonly kind: "TIMEOUT"; readonly rungVersion: number; readonly firedBy?: TimerFiredBy; readonly timerKey?: string }
  | { readonly kind: "DECLINED"; readonly personId: string; readonly rungVersion?: number };

export interface LadderResult {
  readonly status: "MOVED" | "STALE";
  readonly caseItem: Case;
  /** The person the ladder reached on this move, if any. */
  readonly notified?: { readonly rung: Rung; readonly personId: string; readonly firstName: string };
}

const RUNGS = Rung.options;

function rungIndex(rung: Rung): number {
  return RUNGS.indexOf(rung);
}

/** The person a supervisor's rung belongs to (the roster the case copied). */
export function personOfCurrentRung(caseItem: Case): string | undefined {
  if (caseItem.rung === "PRIMARY") return caseItem.roster.primaryId;
  if (caseItem.rung === "SECONDARY") return caseItem.roster.secondaryId;
  return undefined;
}

async function audit(deps: CaseDeps, caseItem: Case, atSim: string, action: string, ruleIds: string[], detail: Record<string, unknown> = {}, decision: "ACTION" | "DENY" = "ACTION"): Promise<void> {
  await deps.connector.audit.append({
    ispId: caseItem.ispId,
    clockId: caseItem.clockId,
    atSim,
    decision,
    action,
    ruleIds,
    actor: "SYSTEM",
    refs: { caseId: caseItem.caseId, workOrderId: caseItem.workOrderId },
    detail,
  });
}

/** What a rung notification reads about the case: the order, its installer and the category in words. */
export async function rungContextBase(deps: CaseDeps, caseItem: Case): Promise<{ workOrder: WorkOrder; installer: Person; reasonText: string }> {
  const [workOrder, installer, steps, checklist] = await Promise.all([
    deps.connector.workOrders.requireWorkOrder(caseItem.workOrderId),
    deps.connector.people.requirePerson(caseItem.installerId),
    deps.connector.workOrders.listSteps(caseItem.workOrderId),
    deps.connector.workOrders.listChecklist(caseItem.workOrderId),
  ]);
  return { workOrder, installer, reasonText: caseReasonText(caseItem, steps, checklist) };
}

function entryOf(rung: Rung, attempt: RungAttempt, atSim: string): LadderEntry {
  if (attempt.outcome === "NOTIFIED") return { rung, outcome: "NOTIFIED", personId: attempt.personId, channel: attempt.channel, messageId: attempt.messageId, atSim };
  return { rung, outcome: "SKIPPED", ...(attempt.personId === undefined ? {} : { personId: attempt.personId }), reason: attempt.reason, atSim };
}

/** Appends an entry under the case's current `rungVersion` and moves the case to the entry's rung. */
async function append(deps: CaseDeps, caseItem: Case, entry: LadderEntry): Promise<Case> {
  return deps.connector.cases.advanceLadder(caseItem.caseId, entry, { rungVersion: caseItem.rungVersion, status: ["OPEN"] }, { rung: entry.rung });
}

function installerNoticeOf(caseItem: Case, rung: Rung, attempt: Extract<RungAttempt, { outcome: "NOTIFIED" }>, reassigned: boolean): string {
  if (rung === "ZONE_CHIEF") return esMX.caseToZoneChief;
  if (caseItem.kind === "SAFETY" && !reassigned) return esMX.safetyCaseOpened;
  return reassigned ? esMX.caseReassigned(attempt.firstName) : esMX.caseOpened(attempt.firstName);
}

/** Notifies rungs from `from` on until one is reached; skipped rungs stay on the ladder with their reason. */
async function climb(deps: CaseDeps, start: Case, from: number, atSim: string): Promise<LadderResult> {
  let caseItem = start;
  const base = await rungContextBase(deps, caseItem);
  for (let index = from; index < RUNGS.length; index += 1) {
    const rung = RUNGS[index] as Rung;
    const reassigned = caseItem.ladder.some((entry) => entry.outcome === "NOTIFIED" && entry.rung !== "ZONE_CHIEF");
    const ctx: RungContext = { caseItem, ...base, atSim, step: caseItem.ladder.length, reassigned };
    const attempt = await notifyRung(deps, ctx, rung);
    caseItem = await append(deps, caseItem, entryOf(rung, attempt, atSim));
    if (attempt.outcome === "SKIPPED") {
      await audit(deps, caseItem, atSim, "CASE_SKIPPED", ["LAD-SKIP"], { rung, reason: attempt.reason, ...(attempt.detail === undefined ? {} : { policy: attempt.detail }) });
      continue;
    }
    const planB = attempt.channel === "INTERACTIVE";
    await audit(deps, caseItem, atSim, "CASE_NOTIFIED", rung === "ZONE_CHIEF" ? ["LAD-ZONE-CHIEF"] : planB ? ["LAD-NOTIFY", "LAD-PLANB"] : ["LAD-NOTIFY"], { rung, channel: attempt.channel });
    if (rung !== "ZONE_CHIEF") await armRungTimeout(deps, { caseId: caseItem.caseId, clockId: caseItem.clockId, ispId: caseItem.ispId, rung, rungVersion: caseItem.rungVersion, notifiedAtSim: atSim });
    await noticeInstaller(deps, caseItem, installerNoticeOf(caseItem, rung, attempt, reassigned), atSim, `${rung}-${caseItem.rungVersion}`);
    return { status: "MOVED", caseItem, notified: { rung, personId: attempt.personId, firstName: attempt.firstName } };
  }
  // Nobody reachable, not even by email: the case waits in the console's inbox.
  deps.logger.warn("case.ladder.unreachable", { caseId: caseItem.caseId });
  return { status: "MOVED", caseItem };
}

async function stale(deps: CaseDeps, caseItem: Case, atSim: string, cause: LadderCause): Promise<LadderResult> {
  const action = cause.kind === "TIMEOUT" ? "CASE_TIMEOUT_IGNORED" : "CASE_DECLINE_IGNORED";
  await audit(deps, caseItem, atSim, action, ["LAD-STALE"], { status: caseItem.status, rung: caseItem.rung, rungVersion: caseItem.rungVersion, ...("rungVersion" in cause && cause.rungVersion !== undefined ? { causeRungVersion: cause.rungVersion } : {}) }, "DENY");
  return { status: "STALE", caseItem };
}

async function open(deps: CaseDeps, caseItem: Case, atSim: string): Promise<LadderResult> {
  if (caseItem.ladder.length > 0) return { status: "STALE", caseItem };
  if (caseItem.reason === "CERTIFICATE_UNDELIVERED") {
    const moved = await deps.connector.cases.advanceLadder(caseItem.caseId, { rung: "PRIMARY", outcome: "NOTIFIED", channel: "CONSOLE", reason: "CONSOLE_ONLY", atSim }, { rungVersion: caseItem.rungVersion, status: ["OPEN"] });
    await audit(deps, moved, atSim, "CASE_NOTIFIED", ["LAD-CONSOLE-ONLY"], { channel: "CONSOLE" });
    return { status: "MOVED", caseItem: moved };
  }
  if (caseItem.kind !== "SAFETY") return climb(deps, caseItem, 0, atSim);
  // Safety: the first supervisor and the zone chief at once, without waiting for any timeout.
  const base = await rungContextBase(deps, caseItem);
  const [result, alert] = await Promise.all([climb(deps, caseItem, 0, atSim), alertZoneChief(deps, { caseItem, ...base, atSim, step: 0 }, "SAFETY")]);
  await audit(deps, result.caseItem, atSim, alert.outcome === "NOTIFIED" ? "SAFETY_ZONE_CHIEF_ALERT" : "SAFETY_ZONE_CHIEF_SKIPPED", ["SAFE-PARALLEL"], alert.outcome === "NOTIFIED" ? {} : { reason: alert.reason });
  return result;
}

async function timeout(deps: CaseDeps, caseItem: Case, atSim: string, cause: Extract<LadderCause, { kind: "TIMEOUT" }>): Promise<LadderResult> {
  if (caseItem.status !== "OPEN" || caseItem.rungVersion !== cause.rungVersion || caseItem.rung === "ZONE_CHIEF") return stale(deps, caseItem, atSim, cause);
  const personId = personOfCurrentRung(caseItem);
  await cancelRungTimeouts(deps, caseItem.caseId, "timed out");
  const timedOut = await deps.connector.cases.advanceLadder(
    caseItem.caseId,
    { rung: caseItem.rung, outcome: "TIMED_OUT", ...(personId === undefined ? {} : { personId }), ...(cause.firedBy === undefined ? {} : { reason: cause.firedBy }), atSim },
    { rungVersion: cause.rungVersion, status: ["OPEN"] },
  );
  await audit(deps, timedOut, atSim, "CASE_TIMED_OUT", ["LAD-TIMEOUT"], { rung: caseItem.rung, ...(cause.timerKey === undefined ? {} : { timerKey: cause.timerKey }) });
  return climb(deps, timedOut, rungIndex(caseItem.rung) + 1, atSim);
}

async function decline(deps: CaseDeps, caseItem: Case, atSim: string, cause: Extract<LadderCause, { kind: "DECLINED" }>): Promise<LadderResult> {
  const versionMatches = cause.rungVersion === undefined || cause.rungVersion === caseItem.rungVersion;
  if (caseItem.status !== "OPEN" || !versionMatches || personOfCurrentRung(caseItem) !== cause.personId) return stale(deps, caseItem, atSim, cause);
  await cancelRungTimeouts(deps, caseItem.caseId, "declined");
  const declined = await deps.connector.cases.advanceLadder(
    caseItem.caseId,
    { rung: caseItem.rung, outcome: "DECLINED", personId: cause.personId, atSim },
    { rungVersion: caseItem.rungVersion, status: ["OPEN"] },
  );
  await deps.connector.audit.append({
    ispId: caseItem.ispId,
    clockId: caseItem.clockId,
    atSim,
    decision: "ACTION",
    action: "CASE_DECLINED",
    ruleIds: ["LAD-DECLINE"],
    actor: `PERSON:${cause.personId}`,
    refs: { caseId: caseItem.caseId, workOrderId: caseItem.workOrderId },
    detail: { rung: caseItem.rung },
  });
  return climb(deps, declined, rungIndex(caseItem.rung) + 1, atSim);
}

/**
 * `advance_ladder`: opens the ladder of a new case, or moves it on after a timeout or a "No puedo".
 * A conditional write that loses to a concurrent move (a take in between) is a stale event.
 */
export async function advanceLadder(deps: CaseDeps, caseId: string, cause: LadderCause, atSim: string): Promise<LadderResult> {
  const caseItem = await deps.connector.cases.requireCase(caseId);
  try {
    switch (cause.kind) {
      case "OPEN":
        return await open(deps, caseItem, atSim);
      case "TIMEOUT":
        return await timeout(deps, caseItem, atSim, cause);
      case "DECLINED":
        return await decline(deps, caseItem, atSim, cause);
    }
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== "CONFLICT") throw error;
    return stale(deps, await deps.connector.cases.requireCase(caseId), atSim, cause);
  }
}
