// What the demo clock view reads beyond the shell's bar (packages/bff/src/routers/clock.ts, `clock.get`):
// the world's version, when it may be reset again, how many scene jumps an hour it allows and until when
// it runs live; who may jump and reset; and the texts of a refusal. Pure: tested without a browser.
import { type ConsoleRole, ispKindOfIspId } from "@cuadrilla/shared";
import { z } from "zod";
import type { ApiError } from "../../lib/api-error";
import type { PendingWork, WorldClock } from "../../lib/world-clock";
import { clockCopy } from "./copy";

/** The fields of `clock.get` the shell's bar does not read (its schema is loose and keeps them). */
export const ClockExtras = z.object({
  worldEpoch: z.number().int().nonnegative().optional(),
  runningUntilReal: z.string().nullable().optional(),
  nextResetAtReal: z.string().nullable().optional(),
  sceneJumpsPerRealHour: z.number().int().positive().optional(),
});
export type ClockExtras = z.infer<typeof ClockExtras>;

/** Scene jumps per real hour when the world does not say (docs/design-brief.md §15). */
export const DEFAULT_SCENE_JUMPS = 30;

export function extrasOf(clock: WorldClock | undefined): ClockExtras {
  const parsed = ClockExtras.safeParse(clock ?? {});
  return parsed.success ? parsed.data : {};
}

/** "Saltar a escena" and "Reiniciar demo" are for supervisors and guests (`supervisorProcedure`). */
export function canDrive(role: ConsoleRole | undefined): boolean {
  return role === "SUPERVISOR" || role === "GUEST";
}

/** Scenes exist only in guest worlds (`clock.jumpToScene` refuses any other). */
export function isGuestWorld(ispId: string | undefined): boolean {
  if (ispId === undefined) return false;
  try {
    return ispKindOfIspId(ispId) === "GUEST";
  } catch {
    return false;
  }
}

/** `HH:MM` of a real instant in the viewer's own time. */
export function realTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The reset is available now unless the world says when it will be again. */
export function resetAvailable(extras: ClockExtras, nowRealMs: number): boolean {
  const next = extras.nextResetAtReal;
  return next === undefined || next === null || Date.parse(next) <= nowRealMs;
}

/** One pending item in words, with how long it has been waiting (real minutes). */
export function pendingText(item: PendingWork, nowRealMs: number): string {
  const minutes = Math.max(0, Math.floor((nowRealMs - Date.parse(item.sinceReal)) / 60_000));
  return `${clockCopy.now.pending[item.kind]}, ${clockCopy.now.since(minutes)}`;
}

/** The view's own words for a refusal it knows; `undefined` leaves it to the generic notice. */
export function refusalText(error: ApiError | undefined): string | undefined {
  if (error === undefined || error.reason === null) return undefined;
  return clockCopy.reasons[error.reason];
}
