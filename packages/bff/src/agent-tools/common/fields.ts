// Schema pieces more than one target repeats. Arguments carry a description (the model reads it in
// the Gateway schema); outputs do not reach the Gateway, so they only fix the shape.
import { z } from "zod";
import { CaseId, CaseReason, SendChannel } from "@cuadrilla/shared";
import { DeliveryTarget } from "../../domain/work-orders";

/** Free text the model writes: trimmed, not empty, bounded (the bound shows in the Gateway schema). */
export function boundedText(max: number, description: string) {
  return z.string().trim().min(1).max(max).describe(description);
}

/**
 * A work order the model names: its public number (`24817`, as `get_work_orders` returns it) or its
 * id. The handler resolves it inside the installer's day (`LAM-SCOPE`), never beyond.
 */
export const WorkOrderRef = z.string().regex(/^(?:\d{5}|wo-\d{5}(?:-[A-Za-z0-9]+)*)$/, "expected a work order number such as 24817");

/** A case the code opened while serving the call (third failed attempt, safety). */
export const CaseOpened = z.strictObject({ caseId: CaseId, reason: CaseReason });
export type CaseOpened = z.infer<typeof CaseOpened>;

/** A delivery of the installation certificate as `close_installation` reports it: queued, not yet sent. */
export const QueuedDelivery = z.strictObject({ to: DeliveryTarget, channel: SendChannel, status: z.literal("QUEUED") });
export type QueuedDelivery = z.infer<typeof QueuedDelivery>;
