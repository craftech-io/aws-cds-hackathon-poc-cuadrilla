// `register_shift` (docs/tool-catalog.md; FL-074, plan B "TURNO"): a supervisor with opt-in writes
// "TURNO" and opens a shift window of 24 simulated hours (`People/PERSON#…/SHIFTWINDOW`). While it is
// open, the ladder may reach the supervisor with an interactive message instead of a template that is
// not approved (`CP-TEMPLATE-APPROVED` → plan B, docs/design-brief.md §5.8). A new "TURNO" moves the
// window; `ACTION SHIFT_REGISTERED`.
//
// The channel calls it with the instant of the inbound message (its simulated time); QA at the world's now.
import { z } from "zod";
import { IsoInstant, SupervisorId, ToolError } from "@cuadrilla/shared";
import { toZonedIso } from "../business-hours/zoned-time";
import { type ServiceDeps, inWorld, openCall, parseInput, recordDecision, worldNow } from "./direct-call";

/** A shift window lasts 24 simulated hours (docs/architecture-integrations.md §4.6). */
export const SHIFT_WINDOW_MS = 24 * 3_600_000;

export const RegisterShiftInput = z
  .object({
    personId: SupervisorId,
    /** Channel only: the simulated instant of the "TURNO" message. */
    atSim: IsoInstant.optional(),
    /** Channel only: the `wamid` of the "TURNO" message. */
    sourceMessageId: z.string().min(1).max(256).optional(),
  })
  .strict();
export type RegisterShiftInput = z.input<typeof RegisterShiftInput>;

export const SHIFT_REASON = {
  NOT_A_SUPERVISOR: "NOT_A_SUPERVISOR",
  PERSON_INACTIVE: "PERSON_INACTIVE",
  NO_OPT_IN: "NO_OPT_IN",
  CHANNEL_ONLY_FIELD: "CHANNEL_ONLY_FIELD",
} as const;

export interface ShiftResult {
  readonly openedAtSim: string;
  readonly closesAtSim: string;
}

export async function registerShift(deps: ServiceDeps, caller: unknown, raw: unknown): Promise<ShiftResult> {
  const call = openCall(caller, { callers: ["CHANNEL", "QA"] });
  const input = parseInput(RegisterShiftInput, raw);
  if (call.kind !== "CHANNEL" && (input.atSim !== undefined || input.sourceMessageId !== undefined)) {
    throw new ToolError("INVALID", "only the channel brings the message's instant", SHIFT_REASON.CHANNEL_ONLY_FIELD);
  }
  const now = await worldNow(deps, call);
  const person = inWorld(call, await deps.connector.people.getPerson(input.personId), "person");
  if (person.role !== "SUPERVISOR") throw new ToolError("FORBIDDEN", "only supervisors register a shift", SHIFT_REASON.NOT_A_SUPERVISOR);
  if (!person.active) throw new ToolError("FORBIDDEN", "the person is not on the allow list", SHIFT_REASON.PERSON_INACTIVE);
  const consent = await deps.connector.people.getConsent(person.personId);
  if (consent?.status !== "GRANTED") throw new ToolError("POLICY_DENIED", "a shift needs the supervisor's opt-in", SHIFT_REASON.NO_OPT_IN);

  const openedAtSim = input.atSim ?? now.atSim;
  const closesAtSim = toZonedIso(new Date(Date.parse(openedAtSim) + SHIFT_WINDOW_MS), now.timeZone);
  await deps.connector.people.openShiftWindow({ personId: person.personId, clockId: call.clockId, openedAtSim, closesAtSim });
  await recordDecision(deps, call, {
    decision: "ACTION",
    action: "SHIFT_REGISTERED",
    atSim: openedAtSim,
    refs: { personId: person.personId },
    ...(input.sourceMessageId === undefined ? {} : { messageId: input.sourceMessageId }),
    detail: { closesAtSim },
  });
  return { openedAtSim, closesAtSim };
}
