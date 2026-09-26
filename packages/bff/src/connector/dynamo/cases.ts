// `Cases` repository (docs/design-brief.md §5.8, ADR-0004): every transition is a conditional write
// on the version read and, for the ladder, on `rungVersion`; "Tomar caso" wins only while the case is
// OPEN. The GSI keys follow the row: `ispStatusKey` moves with the status and `takenByKey` exists only
// while the case is TAKEN, so a supervisor's messages route to the cases they still hold.
import { ConnectorError, type CaseStatus } from "@cuadrilla/shared";
import { Case } from "../../domain/cases";
import type { Transition } from "../../domain/common";
import { caseWorkOrderKey, ispStatusKey, takenByKey } from "../keys";
import type { CaseGuard, CasesPort } from "../ports-data";
import type { Patch, WriteCondition } from "../table-client";
import { createEntity, getEntity, parseRows, patchEntity, requireEntity, withHistory, type RepoContext } from "./repo";

const TABLE = "Cases";
const ATTEMPTS = 3;

function guardCondition(current: Case, guard: CaseGuard): WriteCondition {
  return {
    ifVersion: guard.expectedVersion ?? current.version,
    ...(guard.rungVersion === undefined ? {} : { equals: { rungVersion: guard.rungVersion } }),
    ...(guard.status === undefined ? {} : { oneOf: { status: guard.status } }),
  };
}

/** Fails before writing when the row read already breaks the guard (a stale timeout, a late tap). */
function assertGuard(current: Case, guard: CaseGuard): void {
  const stale = (what: string) => new ConnectorError("CONFLICT", `case ${current.caseId}: ${what}`, TABLE);
  if (guard.expectedVersion !== undefined && guard.expectedVersion !== current.version) throw stale("version changed");
  if (guard.rungVersion !== undefined && guard.rungVersion !== current.rungVersion) throw stale("rungVersion changed");
  if (guard.status !== undefined && !guard.status.includes(current.status)) throw stale(`status is ${current.status}`);
}

function isRace(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === "CONFLICT";
}

export function casesRepo(ctx: RepoContext): CasesPort {
  const { client } = ctx;
  const requireCase = (caseId: string): Promise<Case> => requireEntity(ctx, Case, "Case", { caseId }, `case ${caseId}`);

  /**
   * Reads, checks the guard and writes under it. A write that loses only to an unrelated change
   * (same guard, new version) is retried with the fresh row; a guard that no longer holds is final.
   */
  async function transition(caseId: string, guard: CaseGuard, build: (current: Case) => Patch): Promise<Case> {
    for (let attempt = 1; ; attempt += 1) {
      const current = await requireCase(caseId);
      assertGuard(current, guard);
      try {
        return await patchEntity(ctx, Case, "Case", current, build(current), guardCondition(current, guard));
      } catch (error) {
        if (!isRace(error) || guard.expectedVersion !== undefined || attempt >= ATTEMPTS) throw error;
      }
    }
  }

  const statusHistory = (current: Case, to: CaseStatus | undefined, change: Transition | undefined) =>
    to === undefined || to === current.status || change === undefined ? {} : { history: withHistory(ctx, current.history, "status", current.status, to, change) };

  return {
    createCase: (caseItem) => createEntity(ctx, Case, "Case", caseItem),
    getCase: (caseId) => getEntity(ctx, Case, "Case", { caseId }),
    requireCase,
    async listCasesOfWorkOrder(workOrderId) {
      return parseRows(Case, await client.query(TABLE, { index: "GSI1", hashValue: caseWorkOrderKey(workOrderId) }), TABLE);
    },
    async listCasesByStatus(ispId, status) {
      return parseRows(Case, await client.query(TABLE, { index: "GSI3", hashValue: ispStatusKey(ispId, status) }), TABLE);
    },
    async listTakenBy(personId) {
      return parseRows(Case, await client.query(TABLE, { index: "GSI2", hashValue: takenByKey(personId) }), TABLE).filter((item) => item.status === "TAKEN");
    },

    updateCase: (caseId, patch, guard, change) =>
      transition(caseId, guard, (current) => {
        const withStatus = statusHistory(current, patch.status, change);
        const history = withStatus.history ?? current.history;
        const rungMoved = patch.rung !== undefined && patch.rung !== current.rung;
        return {
          ...patch,
          ...(rungMoved ? { rungVersion: current.rungVersion + 1 } : {}),
          history: rungMoved && change !== undefined ? withHistory(ctx, history, "rung", current.rung, patch.rung, change) : history,
        };
      }),

    advanceLadder: (caseId, entry, guard, move) =>
      transition(caseId, guard, (current) => {
        const ladder = [...current.ladder, entry];
        if (move === undefined || move.rung === current.rung) return { ladder };
        const history = withHistory(ctx, current.history, "rung", current.rung, move.rung, { actor: "SYSTEM", atSim: entry.atSim, reason: entry.outcome });
        return { ladder, rung: move.rung, rungVersion: current.rungVersion + 1, history };
      }),

    takeCase: (caseId, supervisorId, change, guard = {}) =>
      transition(caseId, { ...guard, status: ["OPEN"] }, (current) => ({
        status: "TAKEN",
        takenBy: supervisorId,
        takenAtSim: change.atSim,
        bridge: { open: true, pendingRelays: current.bridge.pendingRelays },
        ladder: [...current.ladder, { rung: current.rung, outcome: "TAKEN", personId: supervisorId, atSim: change.atSim }],
        ...statusHistory(current, "TAKEN", change),
      })),

    closeCase: (caseId, input, change, guard = {}) =>
      transition(caseId, { status: ["OPEN", "TAKEN"], ...guard }, (current) => ({
        status: "CLOSED",
        closedAtSim: change.atSim,
        closedBy: change.actor,
        closeSummary: input.closeSummary,
        bridge: { open: false, pendingRelays: current.bridge.pendingRelays },
        ...statusHistory(current, "CLOSED", change),
      })),
  };
}
