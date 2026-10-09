// What a lost invocation left of a case's ladder, finished on the redelivered event (ADR-0016,
// `LAD-OPEN`, `SAFE-PARALLEL`). The ladder is not one write: `open` notifies the first rung while, on
// a SAFETY case, it emails the zone chief in parallel; each rung first appends its entry and then
// audits it, arms its wait and tells the installer; a skipped rung climbs on to the next one. An
// invocation that dies anywhere in between (a Lambda timeout, an out-of-memory) leaves the case half
// done, so a second open of the same case resumes from what the case, its audit rows, its timers and
// its messages show, never from whether its ladder is empty:
//
//   - an empty ladder runs `open` (both branches)
//   - a SAFETY case with no `SAFETY_ZONE_CHIEF_ALERT` / `_SKIPPED` row emails the zone chief again
//   - a last entry that moved on below ZONE_CHIEF (SKIPPED, TIMED_OUT, DECLINED) climbs from the next rung
//   - a last NOTIFIED entry gets the audit row, the wait (supervisor's rung) and the installer's notice
//     it is missing
//
// Every piece has a deterministic id (messages, email, timer), so nothing goes out twice: a confirmed
// message or mail is replayed, an unconfirmed safety message is sent again (outbound/unconfirmed.ts).
import { ConnectorError, type Rung } from "@cuadrilla/shared";
import type { Decision } from "../domain/audit";
import type { Case, LadderEntry } from "../domain/cases";
import { type LadderResult, alertZoneChiefOfHazard, armWaitOf, audit, auditNotified, climb, noticeOfRung, open, reassignedBefore, rungContextBase, rungIndex, rungNoticeTag } from "./ladder";
import { caseMessageId } from "./notify";
import type { CaseDeps } from "./ports";
import { caseTimeoutId } from "./timeouts";

function audited(rows: readonly Decision[], action: string, rung: Rung): boolean {
  return rows.some((row) => row.action === action && row.detail?.rung === rung);
}

function zoneChiefSettled(rows: readonly Decision[]): boolean {
  return rows.some((row) => row.action === "SAFETY_ZONE_CHIEF_ALERT" || row.action === "SAFETY_ZONE_CHIEF_SKIPPED");
}

async function waitArmed(deps: CaseDeps, caseItem: Case, rung: Rung): Promise<boolean> {
  const timers = await deps.connector.timers.listTimers({ kind: "CASE", id: caseItem.caseId });
  return timers.some((timer) => timer.kind === "CASE_TIMEOUT" && timer.timerId === caseTimeoutId(caseItem.caseId, rung));
}

/** The audit row, the wait and the notice a notified rung may be missing; `true` when one was. */
async function settleNotified(deps: CaseDeps, caseItem: Case, last: LadderEntry, rows: readonly Decision[], atSim: string): Promise<boolean> {
  const { rung } = last;
  let resumed = false;
  if (!audited(rows, "CASE_NOTIFIED", rung)) {
    await auditNotified(deps, caseItem, rung, last.channel, atSim);
    resumed = true;
  }
  if (rung !== "ZONE_CHIEF" && !(await waitArmed(deps, caseItem, rung))) {
    await armWaitOf(deps, caseItem, rung, last.atSim);
    resumed = true;
  }
  const noticeId = caseMessageId(caseItem.caseId, "notice", rungNoticeTag(caseItem, rung));
  if ((await deps.connector.conversations.findMessage(caseItem.installerId, noticeId)) === undefined) {
    const person = last.personId === undefined ? undefined : await deps.connector.people.getPerson(last.personId);
    await noticeOfRung(deps, caseItem, rung, person?.firstName ?? "", reassignedBefore(caseItem.ladder.slice(0, -1)), atSim);
    resumed = true;
  }
  return resumed;
}

/** Finishes the last move of an OPEN case's ladder; `undefined` when it was complete. */
async function finishLastMove(deps: CaseDeps, caseItem: Case, rows: readonly Decision[], atSim: string): Promise<LadderResult | undefined> {
  const last = caseItem.ladder.at(-1);
  if (last === undefined || last.channel === "CONSOLE") return undefined;
  if (last.outcome === "NOTIFIED") return (await settleNotified(deps, caseItem, last, rows, atSim)) ? { status: "MOVED", caseItem } : undefined;
  if (last.outcome === "SKIPPED" && !audited(rows, "CASE_SKIPPED", last.rung)) await audit(deps, caseItem, atSim, "CASE_SKIPPED", ["LAD-SKIP"], { rung: last.rung, ...(last.reason === undefined ? {} : { reason: last.reason }) });
  if (last.rung === "ZONE_CHIEF") return undefined;
  deps.logger.warn("case.ladder.resumed", { caseId: caseItem.caseId, after: last.rung, outcome: last.outcome });
  return climb(deps, caseItem, rungIndex(last.rung) + 1, atSim);
}

async function realertZoneChief(deps: CaseDeps, caseItem: Case, atSim: string): Promise<void> {
  deps.logger.warn("case.zone_chief_alert.resumed", { caseId: caseItem.caseId });
  const base = await rungContextBase(deps, caseItem);
  await alertZoneChiefOfHazard(deps, { caseItem, ...base, atSim, step: 0 });
}

/**
 * Resumes whatever a lost invocation left undone in a case that is not closed. Returns the ladder's
 * move when it climbed or completed a rung, `undefined` when the ladder had nothing pending. A move
 * that loses to a concurrent one (a take, a timeout) leaves the ladder to that move.
 */
export async function resumeLadder(deps: CaseDeps, caseId: string, atSim: string): Promise<LadderResult | undefined> {
  const caseItem = await deps.connector.cases.requireCase(caseId);
  try {
    if (caseItem.status === "OPEN" && caseItem.ladder.length === 0) {
      deps.logger.warn("case.ladder.resumed", { caseId, after: "NONE" });
      return await open(deps, caseItem, atSim);
    }
    const rows = (await deps.connector.audit.listByWorkOrder(caseItem.workOrderId)).filter((row) => row.refs.caseId === caseId);
    const [ladder] = await Promise.all([
      caseItem.status === "OPEN" ? finishLastMove(deps, caseItem, rows, atSim) : undefined,
      caseItem.kind === "SAFETY" && !zoneChiefSettled(rows) ? realertZoneChief(deps, caseItem, atSim) : undefined,
    ]);
    return ladder;
  } catch (error) {
    if (!(error instanceof ConnectorError) || error.code !== "CONFLICT") throw error;
    deps.logger.warn("case.ladder.resume_lost_race", { caseId });
    return undefined;
  }
}
