// `facts.tips` of `get_work_order` (docs/design-brief.md §5.4, FL-027): what the installer's measured
// profile (`InstallerProfile`, written by code, never by a model) says repeats. A reject reason seen at
// least twice in the 30 simulated days up to the turn becomes a tip whose text is the actionable copy
// of that rejection (copy/es-MX.ts), so the agent can remind it when it asks for the photos. Nothing of
// the customer is in a profile event, so nothing of the customer reaches a tip.
import type { PhotoItem, RejectReason } from "@cuadrilla/shared";
import { esMX } from "../../copy/es-MX";
import type { InstallerProfile } from "../../domain/people";

export const TIP_WINDOW_DAYS = 30;
/** Rejections of one reason in the window that make it a tip ("GLARE ≥ 2 en 30 días"). */
export const TIP_MIN_COUNT = 2;

/** The photo a repeated reason is usually about, for the wording of its copy. */
const TIP_ITEM: Readonly<Record<RejectReason, PhotoItem>> = {
  BLURRY: "ONU_LABEL_PHOTO",
  GLARE: "ONU_LABEL_PHOTO",
  CROPPED: "ROSETTE_PHOTO",
  DARK: "ROSETTE_PHOTO",
  WRONG_SUBJECT: "ROSETTE_PHOTO",
  OUT_OF_RANGE_LOW: "POWER_READING_PHOTO",
  OUT_OF_RANGE_HIGH: "POWER_READING_PHOTO",
  WRONG_WAVELENGTH: "POWER_READING_PHOTO",
  SERIAL_MISMATCH: "ONU_LABEL_PHOTO",
  READING_MISMATCH: "POWER_READING_PHOTO",
  DUPLICATE_EVIDENCE: "ROSETTE_PHOTO",
  UNREADABLE: "ONU_LABEL_PHOTO",
};

export interface Tip {
  readonly tipId: string;
  readonly reason: RejectReason;
  readonly count30d: number;
  readonly text: string;
}

/** Tips of the profile at `atSim`, the most repeated first. */
export function tipsOf(profile: Pick<InstallerProfile, "events"> | undefined, atSim: string): Tip[] {
  if (profile === undefined) return [];
  const end = Date.parse(atSim);
  const start = end - TIP_WINDOW_DAYS * 86_400_000;
  const counts = new Map<RejectReason, number>();
  for (const event of profile.events) {
    if (event.kind !== "REJECT") continue;
    const at = Date.parse(event.atSim);
    if (at <= start || at > end) continue;
    const reason = event.code as RejectReason;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= TIP_MIN_COUNT)
    .sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : 1))
    .map(([reason, count]) => ({ tipId: `tip-${reason}`, reason, count30d: count, text: esMX.rejectReason(reason, TIP_ITEM[reason]) }));
}
