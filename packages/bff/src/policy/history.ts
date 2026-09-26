// What a record said at a past instant, from its dated `history[]` (docs/architecture.md §5): every
// transition the policy depends on (consent, allow list, roster, template state, case and order
// status) is written with its instant, so `PolicyAudit` can re-evaluate a sent message "with the data
// of that moment" (FL-077: a BAJA after the send does not make it a violation). A transition counts
// when its simulated instant is at or before the evaluation's simulated instant; one written without
// a simulated instant (console, seed) is compared on real time.
import { CaseStatus, SupervisorId, TemplateName, TemplateStatus, WorkOrderStatus } from "@cuadrilla/shared";
import type { Case } from "../domain/cases";
import type { HistoryEntry } from "../domain/common";
import type { IspSettings, ShiftRoster } from "../domain/isps";
import type { Consent, Person } from "../domain/people";
import type { WorkOrder } from "../domain/work-orders";
import type { ConsentState, PolicyInstant } from "./types";

type Dated = Pick<HistoryEntry, "atSim" | "atReal">;

/** The transition happened at or before `at`. */
export function happenedBy(entry: Dated, at: PolicyInstant): boolean {
  return entry.atSim !== undefined ? Date.parse(entry.atSim) <= Date.parse(at.sim) : Date.parse(entry.atReal) <= Date.parse(at.real);
}

/**
 * The value `field` had at `at`: the current value when every transition of the field happened by
 * then (or there is none), otherwise the value the first later transition started from (`undefined`
 * when the record did not have one yet).
 */
export function valueAt(history: readonly HistoryEntry[], field: string, current: string | undefined, at: PolicyInstant): string | undefined {
  let value: string | undefined;
  let seen = false;
  for (const entry of history) {
    if (entry.field !== field) continue;
    if (!happenedBy(entry, at)) return seen ? value : entry.from;
    value = entry.to;
    seen = true;
  }
  return current;
}

/** The latest instant of `instants` that is not after `bound`. */
export function latestBy(instants: ReadonlyArray<string | undefined>, bound: string): string | undefined {
  const boundMs = Date.parse(bound);
  let latest: string | undefined;
  for (const instant of instants) {
    if (instant === undefined || Date.parse(instant) > boundMs) continue;
    if (latest === undefined || Date.parse(instant) > Date.parse(latest)) latest = instant;
  }
  return latest;
}

/** The opt-in at `at`; a seeded consent without history is dated by `grantedAtSim` and `revokedAtSim`. */
export function consentAt(consent: Consent | undefined, at: PolicyInstant): ConsentState {
  if (consent === undefined) return "NONE";
  if (consent.history.some((entry) => entry.field === "consent")) {
    const value = valueAt(consent.history, "consent", consent.status, at);
    return value === "GRANTED" || value === "REVOKED" ? value : "NONE";
  }
  const simMs = Date.parse(at.sim);
  if (consent.grantedAtSim !== undefined && Date.parse(consent.grantedAtSim) > simMs) return "NONE";
  if (consent.status === "REVOKED" && consent.revokedAtSim !== undefined && Date.parse(consent.revokedAtSim) > simMs) return "GRANTED";
  return consent.status;
}

/** On the allow list at `at`. */
export function activeAt(person: Person, at: PolicyInstant): boolean {
  return valueAt(person.history, "active", String(person.active), at) === "true";
}

export interface RosterIds {
  readonly primaryId?: string;
  readonly secondaryId?: string;
}

/** The supervisors of a crew's roster at `at` (history field `roster` = `<primaryId>/<secondaryId>`). */
export function rosterIdsAt(roster: ShiftRoster, at: PolicyInstant): RosterIds | undefined {
  const value = valueAt(roster.history, "roster", `${roster.primaryId}/${roster.secondaryId}`, at);
  if (value === undefined) return undefined;
  const [primary, secondary] = value.split("/");
  const primaryId = SupervisorId.safeParse(primary);
  const secondaryId = SupervisorId.safeParse(secondary);
  return { ...(primaryId.success ? { primaryId: primaryId.data } : {}), ...(secondaryId.success ? { secondaryId: secondaryId.data } : {}) };
}

/** The simulated state of every template the world listed at `at` (history field `templateStatus.<name>`). */
export function templateStatusAt(settings: IspSettings, at: PolicyInstant): Partial<Record<TemplateName, TemplateStatus>> {
  const statuses: Partial<Record<TemplateName, TemplateStatus>> = {};
  for (const name of TemplateName.options) {
    const status = TemplateStatus.safeParse(valueAt(settings.history, `templateStatus.${name}`, settings.templateStatus[name], at));
    if (status.success) statuses[name] = status.data;
  }
  return statuses;
}

/** A case's status at `at`; `undefined` before it was opened. */
export function caseStatusAt(caseItem: Case, at: PolicyInstant): CaseStatus | undefined {
  if (Date.parse(caseItem.createdAtSim) > Date.parse(at.sim)) return undefined;
  const status = CaseStatus.safeParse(valueAt(caseItem.history, "status", caseItem.status, at));
  return status.success ? status.data : "OPEN";
}

/** An order's status at `at`. */
export function workOrderStatusAt(workOrder: WorkOrder, at: PolicyInstant): WorkOrderStatus {
  const status = WorkOrderStatus.safeParse(valueAt(workOrder.history, "status", workOrder.status, at));
  return status.success ? status.data : workOrder.status;
}
