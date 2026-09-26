// The two windows of the time rules and the clock each one is measured with (ADR-0002, ADR-0010).
// The clock is a property of the recipient's transport, not of the world's mode:
//
//   route          CP-WA-24H (24 h window)                 CP-QUIET-HOURS
//   SIMULATED      world clock, `lastInboundAtSim`         world clock
//   LIVE_WORLD     real clock, `lastInboundAtReal`        real clock (America/Mexico_City)
//   PHONE_LEASE    real clock, the lease's `lastInboundAtReal`   NOT_APPLICABLE_LEASE
//
// A guest's world is paused for days between sessions while Meta measures the window of a leased
// phone in real time: measuring it with the world clock would send free text outside the real
// window (`131047`) and log an ALLOW. Both windows are exported for the modules that need to know
// them before composing a message (the bridge, the certificate deliveries).
import type { PolicyClock } from "./check";
import { evaluateQuietHours, quietHours } from "../services/business-hours/quiet-hours";
import type { PersonRecipient, PolicyFacts, PolicyInstant, WhatsAppRoute } from "./types";

/** WhatsApp's customer service window. */
export const SERVICE_WINDOW_MS = 24 * 3_600_000;

/** The clock the 24 h window of a route is measured with. */
export function windowClockOf(route: WhatsAppRoute): PolicyClock {
  return route === "SIMULATED" ? "WORLD" : "REAL";
}

/** The clock quiet hours are measured with, or none for a phone bound by code to a guest world. */
export function quietClockOf(route: WhatsAppRoute): PolicyClock | "NOT_APPLICABLE_LEASE" {
  if (route === "PHONE_LEASE") return "NOT_APPLICABLE_LEASE";
  return route === "SIMULATED" ? "WORLD" : "REAL";
}

/** "Now" on one of the two clocks of an evaluation. */
export function instantOn(clock: PolicyClock, now: PolicyInstant): Date {
  return new Date(clock === "WORLD" ? now.sim : now.real);
}

export interface ServiceWindow {
  readonly clock: PolicyClock;
  readonly open: boolean;
  /** The inbound the window is measured from, on `clock`; absent when the person never wrote. */
  readonly lastInboundAt?: string;
  /** When the window closes (or closed), on `clock`. */
  readonly closesAt?: string;
}

/** The recipient's 24 h window at `now`: open while less than 24 h passed since its last inbound. */
export function serviceWindowOf(recipient: Pick<PersonRecipient, "route" | "lastInboundAtSim" | "lastInboundAtReal">, now: PolicyInstant): ServiceWindow {
  const clock = windowClockOf(recipient.route);
  const lastInboundAt = clock === "WORLD" ? recipient.lastInboundAtSim : recipient.lastInboundAtReal;
  if (lastInboundAt === undefined) return { clock, open: false };
  const closesAtMs = Date.parse(lastInboundAt) + SERVICE_WINDOW_MS;
  return { clock, open: instantOn(clock, now).getTime() < closesAtMs, lastInboundAt, closesAt: new Date(closesAtMs).toISOString() };
}

export type QuietState =
  | { readonly applies: false }
  | { readonly applies: true; readonly clock: PolicyClock; readonly quiet: false }
  | { readonly applies: true; readonly clock: PolicyClock; readonly quiet: true; readonly nextAllowedAt: Date };

/** Whether `now` falls in the world's quiet hours on the clock of the route, and until when. */
export function quietStateOf(route: WhatsAppRoute, facts: Pick<PolicyFacts, "now" | "world">): QuietState {
  const clock = quietClockOf(route);
  if (clock === "NOT_APPLICABLE_LEASE") return { applies: false };
  const decision = evaluateQuietHours(instantOn(clock, facts.now), quietHours(facts.world.timezone, facts.world.quietHours));
  return decision.quiet ? { applies: true, clock, quiet: true, nextAllowedAt: decision.nextAllowedAt } : { applies: true, clock, quiet: false };
}
