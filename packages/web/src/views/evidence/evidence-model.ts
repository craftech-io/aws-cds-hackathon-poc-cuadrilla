// Evidence review (`/app/evidence`, docs/design-brief.md §6; FL-043, FL-044, ADR-0011) without React: the
// contract of `evidence.queue` and of `evidence.override` checked with zod at the edge, the reason a
// person types, whether the session's sign-in is still recent enough for a manual validation, and the
// queue's filter. Tested in evidence-model.test.ts.
import { z } from "zod";
import { CalendarDate, ChecklistItem, ChecklistItemStatus, PhotoItem, RejectReason, Verdict } from "@cuadrilla/shared";
import { decodeJwtPayload } from "../../lib/auth-claims";
import { SimInstant } from "../../lib/world-clock";

export const EVIDENCE_PROCEDURES = { queue: "evidence.queue", override: "evidence.override" } as const;

const Readings = z.object({ readingDbm: z.number().optional(), wavelengthNm: z.number().optional(), serial: z.string().optional(), serialMatches: z.boolean().optional() });

export const ReviewItem = z.object({
  workOrderId: z.string().min(1),
  workOrderNumber: z.string().min(1),
  // Only photo items are reviewed; the router types the field as any checklist item.
  item: ChecklistItem,
  status: ChecklistItemStatus,
  attempts: z.number().int().min(0),
  lastRejectReason: RejectReason.nullable(),
  validation: z
    .object({
      validationId: z.string(),
      verdict: Verdict,
      modelVerdict: z.enum(["PASS", "REJECT"]).nullable(),
      reasonCode: RejectReason.nullable(),
      readings: Readings,
      checks: z.array(z.string()),
      confidence: z.number().nullable(),
      evidenceId: z.string().nullable(),
      atSim: SimInstant,
    })
    .nullable(),
  rubric: z.object({ version: z.string(), mustShow: z.array(z.string()) }).nullable(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

/** `evidence.queue`: unsure items first (a person decides them), then the rejected ones. */
export const ReviewQueue = z.object({ day: CalendarDate, items: z.array(ReviewItem) });
export type ReviewQueue = z.infer<typeof ReviewQueue>;

/** What `evidence.override` answers once the item is `OVERRIDDEN`. */
export const OverrideResult = z.object({ workOrderId: z.string(), item: PhotoItem, status: z.literal("OVERRIDDEN") });

/** The BFF's bounds of the reason (packages/bff/src/routers/evidence.ts, `OverrideInput`). */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

export type ReasonProblem = "short" | "long" | null;

/** Why a typed reason cannot be sent yet, or null when it can. */
export function reasonProblem(reason: string): ReasonProblem {
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN) return "short";
  if (trimmed.length > REASON_MAX) return "long";
  return null;
}

/** The manual validation needs a sign-in of the last 15 minutes (`recentLoginProcedure`). */
export const RECENT_SIGN_IN_MS = 15 * 60_000;
/** Asked a little early, so a validation typed slowly does not cross the line on its way. */
const MARGIN_MS = 30_000;

const AuthTime = z.object({ auth_time: z.number().int() });

/**
 * True when the id token's sign-in is too old for a manual validation, so the console asks for the
 * password before sending it. An unreadable token is treated as recent: the BFF decides anyway.
 */
export function needsFreshSignIn(idToken: string | undefined, nowMs: number): boolean {
  if (idToken === undefined) return false;
  try {
    const claims = AuthTime.safeParse(decodeJwtPayload(idToken));
    if (!claims.success) return false;
    return nowMs - claims.data.auth_time * 1000 > RECENT_SIGN_IN_MS - MARGIN_MS;
  } catch {
    return false;
  }
}

export type QueueFilter = "ALL" | "UNSURE" | "REJECTED";

export function matchesQueue(item: Pick<ReviewItem, "status">, filter: QueueFilter): boolean {
  if (filter === "ALL") return true;
  return filter === "UNSURE" ? item.status === "IN_REVIEW" : item.status === "REJECTED";
}

/** A row's key: one reviewable item per order and photo item. */
export function reviewKey(item: Pick<ReviewItem, "workOrderId" | "item">): string {
  return `${item.workOrderId}:${item.item}`;
}

/** "92 %" of a model confidence. */
export function percent(confidence: number | null | undefined): string {
  if (confidence === null || confidence === undefined) return "—";
  return `${Math.round(confidence * 100)} %`;
}
