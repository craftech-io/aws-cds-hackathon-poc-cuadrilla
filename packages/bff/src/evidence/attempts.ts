// Rejected attempts of a checklist item (docs/design-brief.md §5.8, FL-042): every REJECT adds one to
// the item's `attempts`; from the third one on, the code opens the `PHOTO_ATTEMPTS` case with the
// evidence of the last three attempts attached. Opening is idempotent by order and reason (cases/,
// WP-34), so a fourth rejection, or a retry after a failed open, finds the same case. UNSURE never
// counts: it is a person's to decide. Nothing here depends on the model.
import type { PhotoItem, Verdict } from "@cuadrilla/shared";
import type { PhotoValidation } from "../domain/work-orders";

export const PHOTO_ATTEMPTS_LIMIT = 3;

export function isPhotoAttemptsDue(verdict: Verdict, attempts: number): boolean {
  return verdict === "REJECT" && attempts >= PHOTO_ATTEMPTS_LIMIT;
}

export interface AttemptRefs {
  /** Most recent first; a duplicate rejected before any copy was kept has no evidence. */
  readonly evidenceIds: string[];
  readonly validationIds: string[];
}

/** The last three rejected validations of the item, newest first. */
export function attemptRefs(validations: readonly PhotoValidation[], item: PhotoItem): AttemptRefs {
  const rejected = validations
    .filter((validation) => validation.item === item && validation.verdict === "REJECT")
    // Same simulated instant (a paused clock): the later ULID first.
    .sort((a, b) => Date.parse(b.atSim) - Date.parse(a.atSim) || (a.validationId < b.validationId ? 1 : -1))
    .slice(0, PHOTO_ATTEMPTS_LIMIT);
  return {
    evidenceIds: rejected.flatMap((validation) => (validation.evidenceId === undefined ? [] : [validation.evidenceId])),
    validationIds: rejected.map((validation) => validation.validationId),
  };
}
