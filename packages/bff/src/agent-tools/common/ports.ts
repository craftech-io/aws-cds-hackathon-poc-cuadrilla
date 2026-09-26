// Ports the wave-3 packages share so none waits for another (docs/build-plan.md §3):
//
//   TimerPort        implemented by timers/ (WP-36); used by the ladder (CASE_TIMEOUT), the outbound
//                    pipeline (DEFERRED_SEND), the certificate deliveries (CERT_RETRY), ScheduleDispatch
//                    and the worker's `fire_timer` (WP-33, WP-34, WP-28).
//   CertificatePort  implemented by certificates/ (WP-35, the `CertificateWriter` Lambda); used by
//                    `close_installation` (WP-34).
//
// The payloads that cross a Lambda boundary (the Scheduler's to `ScheduleDispatch`, `ToolCases` to
// `CertificateWriter`) are zod schemas here, so both sides validate the same shape.
import { z } from "zod";
import { ClockId, IsoInstant, IspId, TimerFiredBy, TimerKind, WorkOrderId } from "@cuadrilla/shared";
import type { TimerRef } from "../../connector/ports";
import { JsonObject, Sha256Hex } from "../../domain/common";
import { type Timer, TimerHome, TimerId } from "../../domain/timers";
import { QueuedDelivery } from "./fields";

// ---- Timers (docs/architecture.md §8, ADR-0004) ------------------------------------------------

/** A timer to create: `TIMER#<kind>#<timerId>` in the partition of its home, due at a simulated instant. */
export const ArmTimerRequest = z.strictObject({
  home: TimerHome,
  kind: TimerKind,
  timerId: TimerId,
  clockId: ClockId,
  dueAtSim: IsoInstant,
  reason: z.string().max(200).optional(),
  /** What the firing needs (`rungVersion` of a CASE_TIMEOUT, the message of a DEFERRED_SEND). */
  payload: JsonObject.optional(),
});
export type ArmTimerRequest = z.infer<typeof ArmTimerRequest>;

/** Input of `ScheduleDispatch`: what each EventBridge Scheduler schedule carries (`tm-<w>-<timerId>`). */
export const ScheduleDispatchPayload = z.strictObject({
  clockId: ClockId,
  /** `timerRefKey` of connector/keys.ts: `<HOME>|<homeId>|<kind>|<timerId>`. */
  timerKey: z.string().min(1).max(256),
  dueAtSim: IsoInstant,
  version: z.int().min(1),
});
export type ScheduleDispatchPayload = z.infer<typeof ScheduleDispatchPayload>;

/** A request to fire one timer: from a schedule, from the clock moving, or forced from the console. */
export const FireTimerRequest = z.strictObject({
  timerKey: z.string().min(1).max(256),
  /** The version the schedule or the caller saw; a newer timer ignores the request. */
  version: z.int().min(1).optional(),
  firedBy: TimerFiredBy,
  /** `eventAtSim` of what the timer triggers: `dueAtSim` when the clock advances, `simNow` when forced. */
  eventAtSim: IsoInstant.optional(),
});
export type FireTimerRequest = z.infer<typeof FireTimerRequest>;

export type FireTimerOutcome =
  /** Now FIRED: the worker dispatches by `kind` with `eventAtSim`. */
  | { readonly status: "FIRED"; readonly timer: Timer; readonly eventAtSim: string }
  /** The world clock has not reached `dueAtSim` yet: re-armed, nothing dispatched. */
  | { readonly status: "NOT_DUE"; readonly timer: Timer }
  /** Another version, or no longer SCHEDULED: ignored and audited by the caller. */
  | { readonly status: "STALE"; readonly timer: Timer; readonly reason: "VERSION" | "NOT_SCHEDULED" }
  | { readonly status: "MISSING" };

/** A timer and the installer whose FIFO group processes it (`MessageGroupId = installerId`, ADR-0017). */
export interface LocatedTimer {
  readonly timer: Timer;
  readonly installerId: string;
}

export interface TimerPort {
  /**
   * Creates the timer SCHEDULED and, while the world clock runs, at most one schedule (also when it
   * is due in under 20 s). Arming a timer that already exists returns it unchanged.
   */
  arm(request: ArmTimerRequest): Promise<Timer>;
  /** Moves a SCHEDULED timer to a new due instant and resyncs its schedule. */
  reschedule(ref: TimerRef, dueAtSim: string, options?: { readonly reason?: string; readonly payload?: JsonObject }): Promise<Timer>;
  /** CANCELLED with its schedule deleted; a timer no longer SCHEDULED is returned as it is. */
  cancel(ref: TimerRef, reason: string): Promise<Timer | undefined>;
  /** The timer a schedule or a clock move names, with its installer; `undefined` when it is gone. */
  locate(timerKey: string): Promise<LocatedTimer | undefined>;
  /** Fires a timer conditionally on its version, re-evaluating `dueAtSim` against the world clock. */
  fire(request: FireTimerRequest): Promise<FireTimerOutcome>;
}

// ---- Certificates (docs/architecture.md §11) ---------------------------------------------------

/** What `close_installation` asks `CertificateWriter` for once the checklist is complete. */
export const IssueCertificateRequest = z.strictObject({
  workOrderId: WorkOrderId,
  ispId: IspId,
  clockId: ClockId,
  /** Who closed: the agent in a turn, the installer's button (no turn) or the scenario runner. */
  closedBy: z.enum(["HARNESS", "CHANNEL", "QA"]),
  closedAtSim: IsoInstant,
  correlationId: z.string().min(1).max(128),
  turnId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});
export type IssueCertificateRequest = z.infer<typeof IssueCertificateRequest>;

/** The certificate written (PDF in `Evidence/certificates/`, `sha256` in `WorkOrders/CERT`) and its queued deliveries. */
export const IssuedCertificate = z.strictObject({
  certificateId: z.string().regex(/^cert-[A-Za-z0-9-]{1,120}$/),
  sha256: Sha256Hex,
  deliveries: z.array(QueuedDelivery),
});
export type IssuedCertificate = z.infer<typeof IssuedCertificate>;

export interface CertificatePort {
  /**
   * Content from the order (never from model text), masked and G3-checked, PDF, `sha256`, deliveries
   * queued through the outbound pipeline. Throws `ToolError`: `UNAVAILABLE` on a transient failure,
   * `POLICY_DENIED` when G3 blocked the content (the writer has opened the `OTHER` case).
   */
  issue(request: IssueCertificateRequest): Promise<IssuedCertificate>;
}
