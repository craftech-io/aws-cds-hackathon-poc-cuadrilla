// `open_case` (docs/tool-catalog.md, handlers of direct invocation): one case per order and reason
// while it is not closed (a second open returns the existing one, `LAD-OPEN`), with the shift roster
// of the order's crew in force at that instant and the zone's chief, then `advance_ladder(OPEN)`.
// Callers: the code that counts attempts (`record_troubleshooting_step`, the validator, the second
// `NOT_PROVISIONED` reading), `escalate_case`, the safety handler, the G1 block, the
// "Consultar a mi supervisor" button, a bounced certificate and the `QaDriver`. The summary is the one
// the caller verified, or the fixed one built by code; it is masked again before it is stored.
import { type CaseKind, type CaseReason, type HazardCategory, isId } from "@cuadrilla/shared";
import type { Case, CaseRoster } from "../domain/cases";
import type { Actor, HistoryEntry } from "../domain/common";
import type { WorkOrder } from "../domain/work-orders";
import { ulid } from "../lib/crypto";
import type { PrefilterBlockKind } from "../lib/mask";
import { localDateOf } from "../services/business-hours/zoned-time";
import { type LadderResult, advanceLadder } from "./ladder";
import type { CaseDeps } from "./ports";
import { REASON_DETAIL_FIELD, cleanSummary } from "./summary";

export interface OpenCaseInput {
  readonly workOrderId: string;
  readonly reason: CaseReason;
  /** Verified by the caller (G2 + facts) or built by code; masked again here. */
  readonly summary: string;
  readonly atSim: string;
  /** Who opened it: `AGENT`, `SYSTEM`, `CHANNEL`, `QA`, `PERSON:<installer>`… */
  readonly actor: Actor;
  readonly hazardCategory?: HazardCategory;
  /** What an `OTHER` case of the pre-G1 block carried (FL-078): only the kind, never the value. */
  readonly sensitive?: PrefilterBlockKind;
  /** Evidence the supervisor should see first (rejected photos of a `PHOTO_ATTEMPTS` case). */
  readonly evidenceIds?: readonly string[];
}

export interface OpenCaseResult {
  readonly caseItem: Case;
  /** A case of the same order and reason was already open: nothing new was sent. */
  readonly existing: boolean;
  readonly ladder?: LadderResult;
}

/** Evidence ids a brief shows at most. */
export const BRIEF_IMAGES = 3;

function kindOf(reason: CaseReason): CaseKind {
  return reason === "SAFETY" ? "SAFETY" : "ESCALATION";
}

/** The roster the case keeps for its whole life (FL-007: an open case keeps its own). */
export async function rosterFor(deps: Pick<CaseDeps, "connector">, workOrder: WorkOrder, atSim: string): Promise<CaseRoster> {
  const { isps } = deps.connector;
  const settings = await isps.getSettings(workOrder.ispId);
  const day = localDateOf(new Date(atSim), settings?.timezone ?? "America/Mexico_City");
  const [shift, zone] = await Promise.all([isps.getRoster(workOrder.ispId, workOrder.crewId, day), isps.getZone(workOrder.ispId, workOrder.zoneId)]);
  return {
    ...(shift === undefined ? {} : { primaryId: shift.primaryId, secondaryId: shift.secondaryId }),
    ...(zone === undefined ? {} : { zoneChiefId: zone.zoneChiefId }),
  };
}

/** The open (not closed) case of an order for a reason, if there is one. */
export async function openCaseOf(deps: Pick<CaseDeps, "connector">, workOrderId: string, reason: CaseReason): Promise<Case | undefined> {
  const cases = await deps.connector.cases.listCasesOfWorkOrder(workOrderId);
  return cases.find((candidate) => candidate.reason === reason && candidate.status !== "CLOSED");
}

async function newCaseId(deps: CaseDeps): Promise<string> {
  const id = deps.newCaseId?.() ?? `case-${ulid((await deps.realClock.now()).getTime())}`;
  if (!isId("case", id)) throw new RangeError(`invalid case id "${id}"`);
  return id;
}

async function latestEvidence(deps: CaseDeps, workOrderId: string): Promise<string[]> {
  const evidence = await deps.connector.workOrders.listEvidence(workOrderId);
  return [...evidence]
    .sort((a, b) => Date.parse(b.receivedAtSim) - Date.parse(a.receivedAtSim))
    .slice(0, BRIEF_IMAGES)
    .map((item) => item.evidenceId);
}

/** Opens the case and its ladder; idempotent per order and reason while the case is not closed. */
export async function openCase(deps: CaseDeps, input: OpenCaseInput): Promise<OpenCaseResult> {
  const workOrder = await deps.connector.workOrders.requireWorkOrder(input.workOrderId);
  const existing = await openCaseOf(deps, workOrder.workOrderId, input.reason);
  if (existing !== undefined) return { caseItem: existing, existing: true };

  const atReal = (await deps.realClock.now()).toISOString();
  const history: HistoryEntry[] =
    input.sensitive === undefined ? [] : [{ field: REASON_DETAIL_FIELD, to: input.sensitive, atSim: input.atSim, atReal, actor: input.actor, reason: "what the blocked message carried" }];
  const evidenceIds = input.evidenceIds !== undefined && input.evidenceIds.length > 0 ? input.evidenceIds.slice(0, BRIEF_IMAGES) : await latestEvidence(deps, workOrder.workOrderId);
  const caseItem = await deps.connector.cases.createCase({
    caseId: await newCaseId(deps),
    ispId: workOrder.ispId,
    clockId: workOrder.clockId,
    workOrderId: workOrder.workOrderId,
    installerId: workOrder.installerId,
    kind: kindOf(input.reason),
    reason: input.reason,
    status: "OPEN",
    rung: "PRIMARY",
    rungVersion: 0,
    roster: await rosterFor(deps, workOrder, input.atSim),
    summary: cleanSummary(input.summary),
    evidenceIds: [...evidenceIds],
    ...(input.hazardCategory === undefined ? {} : { hazardCategory: input.hazardCategory }),
    createdAtSim: input.atSim,
    history,
  });
  await deps.connector.audit.append({
    ispId: caseItem.ispId,
    clockId: caseItem.clockId,
    atSim: input.atSim,
    decision: "ACTION",
    action: "CASE_OPENED",
    ruleIds: ["LAD-OPEN"],
    actor: input.actor,
    refs: { caseId: caseItem.caseId, workOrderId: caseItem.workOrderId },
    detail: { reason: caseItem.reason, kind: caseItem.kind },
  });
  try {
    await deps.connector.people.recordProfileEvent(caseItem.installerId, caseItem.clockId, { kind: "CASE", code: caseItem.reason, atSim: input.atSim, workOrderId: caseItem.workOrderId });
  } catch (error) {
    deps.logger.warn("case.profile_event.failed", { caseId: caseItem.caseId, error });
  }
  const ladder = await advanceLadder(deps, caseItem.caseId, { kind: "OPEN" }, input.atSim);
  return { caseItem: ladder.caseItem, existing: false, ladder };
}
