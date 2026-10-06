// The measured profile of an installer (docs/design-brief.md §5.4, FL-027): counts computed by code,
// never extracted by a model. `validate_install_photo` records every rejected photo with its reason;
// `get_work_order` returns as `facts.tips` the reasons that repeat in the last 30 simulated days, each
// with the actionable text of copy/es-MX.ts for the item it happened on, so the agent reinforces the
// tip when it asks for the photo on the next order. The tip ids are the `refs.tipIds` the agent's
// REPLY cites and the truth of the tips metric.
import type { PhotoItem, RejectReason } from "@cuadrilla/shared";
import { esMX } from "../../copy/es-MX";
import type { PeoplePort, WorkOrdersPort } from "../../connector/ports";
import type { InstallerProfile, ProfileEvent } from "../../domain/people";

export const TIP_WINDOW_DAYS = 30;
/** A reason becomes a tip from its second rejection in the window. */
export const TIP_MIN_REJECTS = 2;
export const MAX_TIPS = 3;

const DAY_MS = 86_400_000;

export interface MeasuredTip {
  readonly tipId: string;
  readonly reason: RejectReason;
  readonly count30d: number;
  readonly text: string;
}

/** `tip-glare`, `tip-out-of-range-low`: one stable id per reason. */
export function tipIdOf(reason: RejectReason): string {
  return `tip-${reason.toLowerCase().replaceAll("_", "-")}`;
}

/** The item a reason belongs to when no rejected validation says it (meter and label readings). */
const ITEM_OF_READING: Partial<Record<RejectReason, PhotoItem>> = {
  OUT_OF_RANGE_LOW: "POWER_READING_PHOTO",
  OUT_OF_RANGE_HIGH: "POWER_READING_PHOTO",
  WRONG_WAVELENGTH: "POWER_READING_PHOTO",
  READING_MISMATCH: "POWER_READING_PHOTO",
  SERIAL_MISMATCH: "ONU_LABEL_PHOTO",
};
/** The label carries the most text to read: the item a quality tip speaks of by default. */
const DEFAULT_TIP_ITEM: PhotoItem = "ONU_LABEL_PHOTO";

function isReject(event: ProfileEvent): event is ProfileEvent & { readonly code: RejectReason } {
  return event.kind === "REJECT";
}

/**
 * Rejections by reason in the 30 simulated days up to `atSim`. Rejections a counter has and no dated
 * event explains (a profile a QA preset seeded with counters only) count as recent, undated.
 */
export function rejectsInWindow(profile: InstallerProfile, atSim: string): Map<RejectReason, ProfileEvent[]> {
  const until = Date.parse(atSim);
  const rejects = profile.events.filter(isReject);
  const counted = new Map<RejectReason, ProfileEvent[]>();
  for (const event of rejects) {
    const at = Date.parse(event.atSim);
    if (at > until || at <= until - TIP_WINDOW_DAYS * DAY_MS) continue;
    counted.set(event.code, [...(counted.get(event.code) ?? []), event]);
  }
  for (const [reason, count] of Object.entries(profile.rejects) as Array<[RejectReason, number]>) {
    const undated = count - rejects.filter((event) => event.code === reason).length;
    if (undated > 0) counted.set(reason, [...(counted.get(reason) ?? []), ...Array.from({ length: undated }, (): ProfileEvent => ({ kind: "REJECT", code: reason, atSim }))]);
  }
  return counted;
}

/** The reasons that repeat, most frequent first, with the item each happened on when it is known. */
export function measuredTips(profile: InstallerProfile, atSim: string, itemOf: (reason: RejectReason) => PhotoItem | undefined = () => undefined): MeasuredTip[] {
  return [...rejectsInWindow(profile, atSim)]
    .filter(([, events]) => events.length >= TIP_MIN_REJECTS)
    .sort(([reasonA, a], [reasonB, b]) => b.length - a.length || (reasonA < reasonB ? -1 : 1))
    .slice(0, MAX_TIPS)
    .map(([reason, events]) => {
      const item = itemOf(reason) ?? ITEM_OF_READING[reason] ?? DEFAULT_TIP_ITEM;
      return { tipId: tipIdOf(reason), reason, count30d: events.length, text: esMX.rejectReason(reason, item) };
    });
}

export interface ProfileDeps {
  readonly people: Pick<PeoplePort, "getProfile">;
  readonly workOrders: Pick<WorkOrdersPort, "listValidations">;
}

/** `facts.tips` of `get_work_order`: the installer's measured tips at the turn's simulated instant. */
export async function tipsForInstaller(deps: ProfileDeps, installerId: string, atSim: string): Promise<MeasuredTip[]> {
  const profile = await deps.people.getProfile(installerId);
  if (profile === undefined) return [];
  const window = rejectsInWindow(profile, atSim);
  const items = new Map<RejectReason, PhotoItem>();
  for (const [reason, events] of window) {
    if (events.length < TIP_MIN_REJECTS) continue;
    // The item comes from the rejected validation of the most recent order the reason happened on.
    for (const workOrderId of [...new Set(events.map((event) => event.workOrderId).filter((id): id is string => id !== undefined))].reverse()) {
      const match = (await deps.workOrders.listValidations(workOrderId)).find((validation) => validation.verdict === "REJECT" && validation.reasonCode === reason);
      if (match !== undefined) {
        items.set(reason, match.item);
        break;
      }
    }
  }
  return measuredTips(profile, atSim, (reason) => items.get(reason));
}

export interface PhotoRejectEvent {
  readonly installerId: string;
  readonly clockId: string;
  readonly reason: RejectReason;
  readonly atSim: string;
  readonly workOrderId: string;
}

/** One rejected photo in the installer's profile (count and dated event). */
export async function recordPhotoReject(people: Pick<PeoplePort, "recordProfileEvent">, event: PhotoRejectEvent): Promise<void> {
  await people.recordProfileEvent(event.installerId, event.clockId, { kind: "REJECT", code: event.reason, atSim: event.atSim, workOrderId: event.workOrderId });
}
