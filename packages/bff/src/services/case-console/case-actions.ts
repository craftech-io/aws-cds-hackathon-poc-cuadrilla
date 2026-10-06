// Case actions of the console (docs/tool-catalog.md, `cases.take` / `cases.close`; FL-065): "Tomar" and
// "Cerrar" on a case of the caller's world. The console does not run `take_case` / `close_case` itself:
// it checks the case can still take the action and queues a `SUPERVISOR_ACTION` in the group of the
// case's installer (queue.ts), so the action never races a turn, a supervisor's button or a rung's
// timeout about the same order (ADR-0017). The worker runs the same conditional writes as the buttons
// (`status` and `rungVersion`): if the case moved in between, the queued action is lost there, audited.
//
//   take    the case is OPEN (otherwise `CONFLICT CASE_NOT_OPEN`); it is taken on behalf of the
//           supervisor of the rung the case is at (the ladder's person the user stands in for: the
//           primary, or the backup at the second rung; the primary when the case already reached the
//           zone chief)
//   close   the case is TAKEN (otherwise `CONFLICT CASE_NOT_TAKEN`), by the supervisor who holds it
//
// The console user is the event's `actor` (`USER:<id>`), which the worker's audit rows name. Only
// `SUPERVISOR` and `GUEST` act (`OPS` → `FORBIDDEN`), and QA in its worlds.
import { z } from "zod";
import { CaseId, ToolError } from "@cuadrilla/shared";
import type { Case } from "../../domain/cases";
import { ACTING_ROLES, type ServiceDeps, inWorld, openCall, parseInput } from "../people/direct-call";
import { type InstallerQueue, consoleEventId } from "./queue";

export interface CaseConsoleDeps extends ServiceDeps {
  readonly queue: InstallerQueue;
}

export const CaseConsoleInput = z.object({ caseId: CaseId, action: z.enum(["TAKE", "CLOSE"]) }).strict();
export type CaseConsoleInput = z.input<typeof CaseConsoleInput>;

export const CASE_CONSOLE_REASON = {
  CASE_NOT_OPEN: "CASE_NOT_OPEN",
  CASE_NOT_TAKEN: "CASE_NOT_TAKEN",
  NO_SUPERVISOR: "NO_SUPERVISOR",
} as const;

export type ConsoleCaseAction = "TAKE_CASE" | "CLOSE_CASE";

export interface CaseConsoleResult {
  readonly queued: true;
  readonly eventId: string;
  readonly action: ConsoleCaseAction;
  /** The supervisor the action runs on behalf of. */
  readonly supervisorId: string;
}

/** The ladder's supervisor of the rung the case is at (the primary once it reached the zone chief). */
function rungSupervisor(found: Case): string | undefined {
  if (found.rung === "SECONDARY") return found.roster.secondaryId ?? found.roster.primaryId;
  return found.roster.primaryId ?? found.roster.secondaryId;
}

export async function requestCaseAction(deps: CaseConsoleDeps, caller: unknown, raw: unknown): Promise<CaseConsoleResult> {
  const call = openCall(caller, { callers: ["CONSOLE", "QA"], consoleRoles: ACTING_ROLES });
  const input = parseInput(CaseConsoleInput, raw);
  const found = inWorld(call, await deps.connector.cases.getCase(input.caseId), "case");
  if (input.action === "TAKE" && found.status !== "OPEN") throw new ToolError("CONFLICT", "the case is no longer open", CASE_CONSOLE_REASON.CASE_NOT_OPEN);
  if (input.action === "CLOSE" && found.status !== "TAKEN") throw new ToolError("CONFLICT", "only a taken case is closed", CASE_CONSOLE_REASON.CASE_NOT_TAKEN);
  const supervisorId = input.action === "TAKE" ? rungSupervisor(found) : found.takenBy;
  if (supervisorId === undefined) throw new ToolError("CONFLICT", "the case has no supervisor to act for", CASE_CONSOLE_REASON.NO_SUPERVISOR);

  const action: ConsoleCaseAction = input.action === "TAKE" ? "TAKE_CASE" : "CLOSE_CASE";
  const eventId = consoleEventId("case", call.clockId, found.caseId, action, found.version);
  await deps.queue.enqueue({
    type: "SUPERVISOR_ACTION",
    action,
    eventId,
    clockId: call.clockId,
    ispId: call.ispId,
    installerId: found.installerId,
    supervisorId,
    caseId: found.caseId,
    rungVersion: found.rungVersion,
    actor: call.actor,
  });
  deps.logger?.info("case.console.queued", { caseId: found.caseId, action, eventId });
  return { queued: true, eventId, action, supervisorId };
}
