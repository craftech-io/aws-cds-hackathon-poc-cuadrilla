// The panel's logic around steps.ts: the language it starts in, where a "VIEW" part of a button leads,
// how long a part may keep the world busy before the panel stops waiting, and who may jump to a scene.
// Pure: tested without a browser.
import type { ConsoleRole } from "@cuadrilla/shared";
import { type RouteId, homeOf, pathOf } from "../../routes";
import type { TourLang, TourStep } from "./steps";

/** The panel speaks English when the browser does, Spanish otherwise (it switches by hand too). */
export function initialLang(language: string | undefined): TourLang {
  return language?.toLowerCase().startsWith("en") ? "en" : "es";
}

/** Views a button of the tour opens (the BFF's `VIEW` part). */
const VIEW_ROUTES: Readonly<Record<string, RouteId>> = { metrics: "metrics", manual: "manual", outbox: "outbox", cases: "cases", orders: "orders" };

/** Where a `VIEW` part leads: a view of the console, or the home of the role. */
export function viewPath(view: string, role: ConsoleRole | undefined): string {
  const route = VIEW_ROUTES[view];
  return route === undefined ? homeOf(role) : pathOf(route);
}

/** The view a part's result asks to open, if it is one (`{ kind: "VIEW", result: { view } }`). */
export function viewOfResult(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const { kind, result: inner } = result as { kind?: unknown; result?: unknown };
  if (kind !== "VIEW" || typeof inner !== "object" || inner === null) return undefined;
  const view = (inner as { view?: unknown }).view;
  return typeof view === "string" ? view : undefined;
}

/** How long the panel waits for a busy world after one part: twice the step's wait, at least 30 s. */
export function waitLimitMs(step: Pick<TourStep, "waitSec">): number {
  return Math.max(30, step.waitSec * 2) * 1000;
}

/** "Saltar a escena" exists in guest worlds, for supervisors and guests (`clock.jumpToScene`). */
export function canJump(role: ConsoleRole | undefined, guestWorld: boolean): boolean {
  return guestWorld && (role === "SUPERVISOR" || role === "GUEST");
}
