// `set_roster` (docs/tool-catalog.md; FL-007): who supervises a crew on a simulated day, on duty
// (`PRIMARY`) and as backup (`SECONDARY`). The console (or the QaDriver) changes it; every change enters
// the roster's dated history (`Isps/ROSTER#<crewId>#<date>.history[]`) and `ACTION ROSTER_SET`. A case
// copies the roster in force when it opens (`CP-ROSTER`), so cases already open keep theirs.
//
// Both supervisors are active supervisors of the caller's world and differ; the shift keeps its hours
// unless new ones come, and a new roster takes the day's 07:00-19:00 in the world's time zone
// (docs/seed-spec.md §4).
import { z } from "zod";
import { CalendarDate, CrewId, IsoInstant, SupervisorId, ToolError } from "@cuadrilla/shared";
import type { ShiftRoster } from "../../domain/isps";
import { toZonedIso, zonedInstant } from "../business-hours/zoned-time";
import { ACTING_ROLES, type DirectCall, type ServiceDeps, inWorld, openCall, parseInput, recordDecision, worldNow } from "./direct-call";

/** Hours of a new roster (docs/seed-spec.md §4: "07:00-19:00"). */
export const DEFAULT_SHIFT = { start: "07:00", end: "19:00" } as const;

export const SetRosterInput = z
  .object({
    crewId: CrewId,
    date: CalendarDate,
    primaryId: SupervisorId,
    secondaryId: SupervisorId,
    /** Both or neither: a new shift's hours. */
    startsAtSim: IsoInstant.optional(),
    endsAtSim: IsoInstant.optional(),
  })
  .strict();
export type SetRosterInput = z.input<typeof SetRosterInput>;

export const ROSTER_REASON = {
  SAME_SUPERVISOR: "SAME_SUPERVISOR",
  NOT_A_SUPERVISOR: "NOT_A_SUPERVISOR",
  SUPERVISOR_INACTIVE: "SUPERVISOR_INACTIVE",
  HOURS_INCOMPLETE: "HOURS_INCOMPLETE",
  HOURS_INVERTED: "HOURS_INVERTED",
} as const;

export interface RosterView {
  readonly crewId: string;
  readonly date: string;
  readonly primaryId: string;
  readonly secondaryId: string;
  readonly startsAtSim: string;
  readonly endsAtSim: string;
  /** Dated changes the roster keeps. */
  readonly changes: number;
}

function rosterView(roster: ShiftRoster): RosterView {
  const { crewId, date, primaryId, secondaryId, startsAtSim, endsAtSim } = roster;
  return { crewId, date, primaryId, secondaryId, startsAtSim, endsAtSim, changes: roster.history.length };
}

async function requireSupervisor(deps: ServiceDeps, call: DirectCall, personId: string): Promise<void> {
  const person = inWorld(call, await deps.connector.people.getPerson(personId), "supervisor");
  if (person.role !== "SUPERVISOR") throw new ToolError("INVALID", "only supervisors go on a roster", ROSTER_REASON.NOT_A_SUPERVISOR);
  if (!person.active) throw new ToolError("INVALID", "an inactive supervisor cannot be on a roster", ROSTER_REASON.SUPERVISOR_INACTIVE);
}

function hoursOf(input: z.output<typeof SetRosterInput>, current: ShiftRoster | undefined, timeZone: string): { startsAtSim: string; endsAtSim: string } {
  if ((input.startsAtSim === undefined) !== (input.endsAtSim === undefined)) throw new ToolError("INVALID", "a shift needs both its start and its end", ROSTER_REASON.HOURS_INCOMPLETE);
  const hours =
    input.startsAtSim !== undefined && input.endsAtSim !== undefined
      ? { startsAtSim: input.startsAtSim, endsAtSim: input.endsAtSim }
      : (current ?? {
          startsAtSim: toZonedIso(zonedInstant(input.date, DEFAULT_SHIFT.start, timeZone), timeZone),
          endsAtSim: toZonedIso(zonedInstant(input.date, DEFAULT_SHIFT.end, timeZone), timeZone),
        });
  if (Date.parse(hours.startsAtSim) >= Date.parse(hours.endsAtSim)) throw new ToolError("INVALID", "a shift ends after it starts", ROSTER_REASON.HOURS_INVERTED);
  return { startsAtSim: hours.startsAtSim, endsAtSim: hours.endsAtSim };
}

export async function setRoster(deps: ServiceDeps, caller: unknown, raw: unknown): Promise<RosterView> {
  const call = openCall(caller, { callers: ["CONSOLE", "QA"], consoleRoles: ACTING_ROLES });
  const input = parseInput(SetRosterInput, raw);
  const now = await worldNow(deps, call);
  if ((await deps.connector.isps.getCrew(call.ispId, input.crewId)) === undefined) throw new ToolError("NOT_FOUND", "crew not found");
  if (input.primaryId === input.secondaryId) throw new ToolError("INVALID", "the backup is another supervisor", ROSTER_REASON.SAME_SUPERVISOR);
  await requireSupervisor(deps, call, input.primaryId);
  await requireSupervisor(deps, call, input.secondaryId);
  const current = await deps.connector.isps.getRoster(call.ispId, input.crewId, input.date);
  const roster = await deps.connector.isps.setRoster(
    { ispId: call.ispId, clockId: call.clockId, crewId: input.crewId, date: input.date, primaryId: input.primaryId, secondaryId: input.secondaryId, ...hoursOf(input, current, now.timeZone) },
    { actor: call.actor, atSim: now.atSim },
  );
  await recordDecision(deps, call, {
    decision: "ACTION",
    action: "ROSTER_SET",
    atSim: now.atSim,
    refs: { crewId: input.crewId, date: input.date },
    detail: { primaryId: roster.primaryId, secondaryId: roster.secondaryId, ...(current === undefined ? {} : { previous: `${current.primaryId}/${current.secondaryId}` }) },
  });
  return rosterView(roster);
}
