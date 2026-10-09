// The day's work orders (`/app/orders`, docs/design-brief.md §6; FL-080) without React: the contract of
// `orders.list` checked with zod at the edge, the filters (status and open cases, counted), the five
// checklist marks of a row and the crews of the scope. Tested in orders-model.test.ts.
import { z } from "zod";
import { CalendarDate, ChecklistItem, ChecklistItemStatus, OnuOperState, WorkOrderStatus } from "@cuadrilla/shared";
import type { PillOption } from "../../components/FilterPills";
import { SimInstant } from "../../lib/world-clock";
import { CONSOLE_PREFIX } from "../../routes";
import { CHECKLIST_ORDER, checklistItemLabel, checklistStatusLabel } from "./labels";

export const ORDERS_PROCEDURES = { list: "orders.list", roster: "people.roster.get" } as const;

const Name = z.object({ firstName: z.string(), lastName: z.string() });

export const ChecklistMark = z.object({ item: ChecklistItem, status: ChecklistItemStatus });
export type ChecklistMark = z.infer<typeof ChecklistMark>;

export const OnuReadingView = z.object({ operState: OnuOperState, rxPowerDbm: z.number().optional(), inRange: z.boolean() });
export type OnuReadingView = z.infer<typeof OnuReadingView>;

export const Window = z.object({ startSim: SimInstant, endSim: SimInstant });

/** One row of `orders.list` (packages/bff/src/routers/orders.ts, `rowOf`). */
export const OrderRow = z.object({
  workOrderId: z.string().min(1),
  workOrderNumber: z.string().min(1),
  status: WorkOrderStatus,
  crewId: z.string().min(1),
  installer: Name.extend({ personId: z.string().optional() }),
  customer: Name.extend({ neighborhood: z.string() }).nullable(),
  window: Window,
  plan: z.string(),
  checklist: z.array(ChecklistMark),
  onu: OnuReadingView.nullable(),
  openCases: z.number().int().min(0),
  onHoldSafety: z.boolean(),
  mainStory: z.boolean(),
});
export type OrderRow = z.infer<typeof OrderRow>;

export const OrdersPage = z.object({ day: CalendarDate, simNow: SimInstant, workOrders: z.array(OrderRow) });
export type OrdersPage = z.infer<typeof OrdersPage>;

/** What `people.roster.get` answers that the scope needs: the crew's name. */
export const CrewName = z.object({ crewId: z.string(), crewName: z.string() });

export type StatusFilter = "ALL" | "OPEN" | "CLOSED" | "ISSUES";
export type CaseFilter = "ALL" | "WITH_CASES";

const OPEN: ReadonlySet<string> = new Set(["SCHEDULED", "IN_PROGRESS"]);
const ISSUES: ReadonlySet<string> = new Set(["FAILED_VISIT", "RESCHEDULED", "CANCELLED", "REASSIGNED"]);

export function matchesStatus(row: Pick<OrderRow, "status" | "onHoldSafety">, filter: StatusFilter): boolean {
  switch (filter) {
    case "ALL":
      return true;
    case "OPEN":
      return OPEN.has(row.status) && !row.onHoldSafety;
    case "CLOSED":
      return row.status === "CLOSED";
    case "ISSUES":
      return ISSUES.has(row.status) || row.onHoldSafety;
  }
}

export function matchesCases(row: Pick<OrderRow, "openCases">, filter: CaseFilter): boolean {
  return filter === "ALL" || row.openCases > 0;
}

export function filterRows<R extends Pick<OrderRow, "status" | "onHoldSafety" | "openCases">>(rows: readonly R[], status: StatusFilter, cases: CaseFilter): R[] {
  return rows.filter((row) => matchesStatus(row, status) && matchesCases(row, cases));
}

export interface FilterTexts {
  readonly status: Readonly<Record<StatusFilter, string>>;
  readonly cases: Readonly<Record<CaseFilter, string>>;
}

/** The pills of each filter, each counted over the rows the other filter leaves. */
export function filterOptions(rows: readonly OrderRow[], status: StatusFilter, cases: CaseFilter, texts: FilterTexts) {
  const statusValues: readonly StatusFilter[] = ["ALL", "OPEN", "CLOSED", "ISSUES"];
  const caseValues: readonly CaseFilter[] = ["ALL", "WITH_CASES"];
  const statusOptions: PillOption<StatusFilter>[] = statusValues.map((value) => ({ value, label: texts.status[value], count: filterRows(rows, value, cases).length }));
  const caseOptions: PillOption<CaseFilter>[] = caseValues.map((value) => ({ value, label: texts.cases[value], count: filterRows(rows, status, value).length }));
  return { statusOptions, caseOptions };
}

export type MarkState = "done" | "rejected" | "review" | "pending";

const STATE: Readonly<Record<ChecklistItemStatus, MarkState>> = { PASSED: "done", OVERRIDDEN: "done", REJECTED: "rejected", IN_REVIEW: "review", PENDING: "pending" };

export interface Mark {
  readonly item: ChecklistItem;
  readonly state: MarkState;
  /** "Foto del medidor: Validado". */
  readonly label: string;
}

/** The five checklist items in closing order, a missing one read as pending. */
export function checklistMarks(checklist: readonly ChecklistMark[]): Mark[] {
  return CHECKLIST_ORDER.map((item) => {
    const status = checklist.find((entry) => entry.item === item)?.status ?? "PENDING";
    return { item, state: STATE[status], label: `${checklistItemLabel[item]}: ${checklistStatusLabel[status]}` };
  });
}

/** "3 de 5". */
export function checklistProgress(checklist: readonly ChecklistMark[]): { readonly done: number; readonly total: number } {
  const marks = checklistMarks(checklist);
  return { done: marks.filter((mark) => mark.state === "done").length, total: marks.length };
}

/** The crews of the day's orders, in the order they first appear. */
export function crewIdsOf(rows: readonly Pick<OrderRow, "crewId">[]): string[] {
  return [...new Set(rows.map((row) => row.crewId))];
}

/** A crew's visible name: what the roster says, or "Equipo 1", "Equipo 2" by order while it is unknown. */
export function crewLabel(crewId: string, names: Readonly<Record<string, string>>, known: readonly string[], fallback: (index: number) => string): string {
  const name = names[crewId];
  if (name !== undefined) return name;
  const index = known.indexOf(crewId);
  return fallback(index === -1 ? known.length + 1 : index + 1);
}

/** "Rogelio Méndez". */
export function fullName(name: { readonly firstName: string; readonly lastName: string } | null | undefined): string {
  if (!name) return "—";
  return `${name.firstName} ${name.lastName}`.trim();
}

/** The link of an order's detail. */
export function orderHref(workOrderId: string): string {
  return `${CONSOLE_PREFIX}/orders/${encodeURIComponent(workOrderId)}`;
}

/** The rows of the scope's crew, or every row when the scope has none. */
export function inScope<R extends Pick<OrderRow, "crewId">>(rows: readonly R[], crewId: string | undefined): R[] {
  return crewId === undefined ? [...rows] : rows.filter((row) => row.crewId === crewId);
}
