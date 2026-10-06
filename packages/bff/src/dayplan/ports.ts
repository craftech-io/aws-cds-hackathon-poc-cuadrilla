// What the day plan needs from the packages that run beside it in wave 3 (docs/build-plan.md §3): the
// timers (`TimerPort` of agent-tools/common/ports.ts, implemented by timers/) and the send of the
// `ordenes_del_dia` template, which goes through the outbound pipeline like every send (outbound/,
// CLAUDE.md "Todo envío sale por el pipeline"): contact policy first (`CP-OPTIN`, `CP-OPTOUT`,
// `CP-QUIET-HOURS`, `CP-ONE-DAYSTART`, `CP-WA-24H`, `CP-TEMPLATE-APPROVED`, with its `AuditLog` row),
// then G3 over the parameters, the nonce of the "Ver órdenes" button, the transport and `Conversations`.
// The worker builds these deps; tests pass fakes over the in-memory connector.
import type { CalendarDate, TemplateName } from "@cuadrilla/shared";
import type { TimerPort } from "../agent-tools/common/ports";
import type { Connector } from "../connector/ports";
import type { NonceObject } from "../domain/runtime";
import type { Logger } from "../lib/log";

/** The `DAY_START` message of one installer and day, built by code from the stored orders. */
export interface DayStartSendRequest {
  readonly ispId: string;
  readonly clockId: string;
  /** The recipient: the installer, always (the template's audience). */
  readonly installerId: string;
  readonly date: CalendarDate;
  /** Simulated instant the start of the day fired at: the instant the policy is evaluated at. */
  readonly eventAtSim: string;
  readonly correlationId: string;
  readonly kind: "DAY_START";
  readonly templateName: Extract<TemplateName, "ordenes_del_dia">;
  /** `{{1}}` first name, `{{2}}` number of orders, `{{3}}` window of the first appointment. */
  readonly params: readonly [string, string, string];
  /** "Ver órdenes": the pipeline issues its nonce for this object. */
  readonly buttons: readonly [{ readonly action: "VIEW_ORDERS"; readonly object: NonceObject }];
  /** `refs.workOrderIds`: the orders the parameters were counted from. */
  readonly workOrderIds: readonly string[];
  /** The timer that fired, for the audit row (`timerRefKey` of connector/keys.ts). */
  readonly timerKey?: string;
}

export type DayStartSendOutcome =
  | { readonly status: "SENT"; readonly messageId: string; readonly ruleIds: readonly string[] }
  | { readonly status: "DENIED"; readonly ruleIds: readonly string[]; readonly reason?: string }
  | { readonly status: "DEFERRED"; readonly ruleIds: readonly string[]; readonly nextAllowedAt: string };

export interface DayStartSender {
  /** Policy, G3, render and transport; never throws for a denial (it is an outcome with its rule). */
  sendDayStart(request: DayStartSendRequest): Promise<DayStartSendOutcome>;
}

export interface DayPlanDeps {
  readonly connector: Pick<Connector, "isps" | "people" | "workOrders" | "timers" | "worlds" | "audit">;
  readonly timers: Pick<TimerPort, "arm">;
  readonly logger: Logger;
}

export interface DayStartDeps extends DayPlanDeps {
  readonly sender: DayStartSender;
}
