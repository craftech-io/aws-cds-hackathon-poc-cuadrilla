// Cases (`/app/cases` and `/app/cases/:caseId`, docs/design-brief.md §5.8 and §6; FL-051, FL-055, FL-065)
// without React: the contracts of `cases.list`, `cases.get` and of "Tomar" / "Cerrar" checked with zod at
// the edge, the inbox filters (status and reason, counted), the ladder drawn rung by rung (notified,
// timeout pending, skipped and why, taken) and which action a role may take on a case. Tested in
// cases-model.test.ts.
import { z } from "zod";
import { CaseKind, CaseReason, CaseStatus, type ConsoleRole, HazardCategory, Rung, RungOutcome } from "@cuadrilla/shared";
import { SimInstant } from "../../lib/world-clock";
import { CONSOLE_PREFIX } from "../../routes";

export const CASES_PROCEDURES = { list: "cases.list", get: "cases.get", take: "cases.take", close: "cases.close" } as const;

export const CaseSummary = z.object({
  caseId: z.string().min(1),
  workOrderId: z.string().min(1),
  workOrderNumber: z.string().nullable(),
  installer: z.string().nullable(),
  kind: CaseKind,
  reason: CaseReason,
  status: CaseStatus,
  rung: Rung,
  takenBy: z.string().nullable(),
  createdAtSim: SimInstant,
  closedAtSim: SimInstant.nullable(),
});
export type CaseSummary = z.infer<typeof CaseSummary>;

export const CaseList = z.array(CaseSummary);

export const LadderStep = z.object({
  rung: Rung,
  outcome: RungOutcome,
  person: z.string().nullable(),
  reason: z.string().optional(),
  channel: z.string().optional(),
  atSim: SimInstant,
});
export type LadderStep = z.infer<typeof LadderStep>;

export const BridgeMessage = z.object({
  messageId: z.string(),
  direction: z.enum(["IN", "OUT"]),
  kind: z.string().nullable(),
  content: z.string(),
  text: z.string().nullable(),
  templateName: z.string().nullable(),
  status: z.string(),
  sentAtSim: SimInstant,
});
export type BridgeMessage = z.infer<typeof BridgeMessage>;

/** `cases.get` (packages/bff/src/routers/cases.ts, `caseDetail`). */
export const CaseDetail = CaseSummary.extend({
  summary: z.string(),
  hazardCategory: HazardCategory.nullable(),
  roster: z.object({ primary: z.string().nullable(), secondary: z.string().nullable(), zoneChief: z.string().nullable() }),
  ladder: z.array(LadderStep),
  pendingTimeout: z.object({ dueAtSim: SimInstant, rung: Rung }).nullable(),
  bridge: z.object({ open: z.boolean(), pendingRelays: z.number().int().min(0) }),
  messages: z.array(BridgeMessage),
  closeSummary: z.string().nullable(),
});
export type CaseDetail = z.infer<typeof CaseDetail>;

/** "Tomar" and "Cerrar" queue the same action a supervisor's button runs; the worker applies it. */
export const CaseActionQueued = z.object({ queued: z.literal(true), action: z.enum(["TAKE_CASE", "CLOSE_CASE"]) });

export type StatusFilter = "ACTIVE" | CaseStatus | "ALL";

export function matchesStatus(row: Pick<CaseSummary, "status">, filter: StatusFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "ACTIVE") return row.status !== "CLOSED";
  return row.status === filter;
}

/** The reasons present in the inbox, in the enum's order, each with how many cases it has. */
export function reasonsOf(rows: readonly Pick<CaseSummary, "reason">[]): { readonly reason: CaseReason; readonly count: number }[] {
  return CaseReason.options.flatMap((reason) => {
    const count = rows.filter((row) => row.reason === reason).length;
    return count === 0 ? [] : [{ reason, count }];
  });
}

export function filterCases<R extends Pick<CaseSummary, "status" | "reason">>(rows: readonly R[], status: StatusFilter, reason: CaseReason | "ALL"): R[] {
  return rows.filter((row) => matchesStatus(row, status) && (reason === "ALL" || row.reason === reason));
}

/** One rung of the ladder as the console draws it: who, what happened to each attempt, and what is pending. */
export interface RungView {
  readonly rung: Rung;
  /** Who the roster names for the rung, if anyone. */
  readonly person: string | null;
  readonly steps: readonly LadderStep[];
  /** The rung the case is at right now (with its timeout, if one is pending). */
  readonly current: boolean;
  readonly pendingDueAtSim: string | null;
  /** Not reached yet. */
  readonly ahead: boolean;
}

const RUNGS: readonly Rung[] = Rung.options;

/**
 * The three rungs in climbing order. A rung is `current` while the case is not closed and sits there;
 * the rungs after it are `ahead` unless the ladder already recorded something for them (a skip).
 */
export function ladderOf(detail: Pick<CaseDetail, "ladder" | "rung" | "status" | "roster" | "pendingTimeout">): RungView[] {
  const atIndex = RUNGS.indexOf(detail.rung);
  const roster: Readonly<Record<Rung, string | null>> = { PRIMARY: detail.roster.primary, SECONDARY: detail.roster.secondary, ZONE_CHIEF: detail.roster.zoneChief };
  return RUNGS.map((rung, index) => {
    const steps = detail.ladder.filter((step) => step.rung === rung).sort((a, b) => a.atSim.localeCompare(b.atSim));
    const current = detail.status !== "CLOSED" && rung === detail.rung;
    return {
      rung,
      person: steps.find((step) => step.person !== null)?.person ?? roster[rung],
      steps,
      current,
      pendingDueAtSim: current && detail.pendingTimeout !== null && detail.pendingTimeout.rung === rung ? detail.pendingTimeout.dueAtSim : null,
      ahead: index > atIndex && steps.length === 0,
    };
  });
}

/** The actions a role may ask on a case in its current state (`OPS` only looks; `supervisorProcedure`). */
export function caseActions(role: ConsoleRole | undefined, status: CaseStatus): { readonly take: boolean; readonly close: boolean } {
  const acts = role === "SUPERVISOR" || role === "GUEST";
  return { take: acts && status === "OPEN", close: acts && status === "TAKEN" };
}

/** A case of the console-only kind never goes to WhatsApp (`LAD-CONSOLE-ONLY`). */
export function isConsoleOnly(reason: CaseReason): boolean {
  return reason === "CERTIFICATE_UNDELIVERED";
}

export function caseHref(caseId: string): string {
  return `${CONSOLE_PREFIX}/cases/${encodeURIComponent(caseId)}`;
}

export const CASES_HOME = `${CONSOLE_PREFIX}/cases`;
