// Route table of the web: the public pages and one entry per console view of docs/design-brief.md
// §6, with the roles that may open it (docs/architecture.md §10). The id of a console route is the
// directory of its view (`views/<id>/view.tsx`, lib/view-registry.ts); console-routes.tsx matches
// the path and the AppShell builds the navigation from the same table.
import type { ConsoleRole } from "@cuadrilla/shared";
import { copy } from "./copy/console";
import { matchPath } from "./lib/match-path";

export type RouteId = keyof typeof copy.views;

export type NavGroup = keyof typeof copy.nav.groups;

export interface ConsoleRoute {
  readonly id: RouteId;
  /** Path patterns the view answers; the first one is its link in the navigation. */
  readonly patterns: readonly [string, ...string[]];
  readonly group: NavGroup;
  /** Roles allowed in; "ALL" means every console role. */
  readonly roles: readonly ConsoleRole[] | "ALL";
  /** A view reached from another one (the detail of an order) marks that one in the navigation. */
  readonly navAs?: RouteId;
}

export const CONSOLE_PREFIX = "/app";

export const ROUTES: readonly ConsoleRoute[] = [
  { id: "orders", patterns: [`${CONSOLE_PREFIX}/orders`], group: "work", roles: "ALL" },
  { id: "order-detail", patterns: [`${CONSOLE_PREFIX}/orders/:workOrderId`], group: "work", roles: "ALL", navAs: "orders" },
  { id: "cases", patterns: [`${CONSOLE_PREFIX}/cases`, `${CONSOLE_PREFIX}/cases/:caseId`], group: "work", roles: "ALL" },
  { id: "evidence", patterns: [`${CONSOLE_PREFIX}/evidence`], group: "work", roles: "ALL" },
  { id: "people", patterns: [`${CONSOLE_PREFIX}/people`], group: "team", roles: "ALL" },
  { id: "manual", patterns: [`${CONSOLE_PREFIX}/manual`, `${CONSOLE_PREFIX}/manual/:sectionId`], group: "team", roles: "ALL" },
  { id: "simulator", patterns: [`${CONSOLE_PREFIX}/simulator`], group: "demo", roles: "ALL" },
  { id: "clock", patterns: [`${CONSOLE_PREFIX}/clock`], group: "demo", roles: "ALL" },
  { id: "outbox", patterns: [`${CONSOLE_PREFIX}/outbox`], group: "demo", roles: "ALL" },
  { id: "metrics", patterns: [`${CONSOLE_PREFIX}/metrics`], group: "control", roles: "ALL" },
  { id: "audit", patterns: [`${CONSOLE_PREFIX}/audit`], group: "control", roles: "ALL" },
];

export const LOGIN_PATH = "/login";

/** The public welcome page of the demo (views/landing). */
export const LANDING_PATH = "/";

/** Public page with the QR code staff scan to opt in ("Envía ALTA a este número"). */
export const JOIN_PATH = "/join";

/** Public pages served by the web itself; the legal pages are static files under public/legal/. */
export type PublicPageId = "join";

/** Where a sign-in lands when nothing asked for another view. */
export const CONSOLE_HOME = `${CONSOLE_PREFIX}/orders`;

export interface RouteMatch {
  readonly route: ConsoleRoute;
  readonly params: Readonly<Record<string, string>>;
}

/** The console route of a path and its named segments; undefined for a path no view answers. */
export function matchRoute(path: string): RouteMatch | undefined {
  for (const route of ROUTES) {
    for (const pattern of route.patterns) {
      const params = matchPath(pattern, path);
      if (params) return { route, params };
    }
  }
  return undefined;
}

/** `/app` and `/app/` lead to the console's home. */
export function isConsoleRoot(path: string): boolean {
  return path === CONSOLE_PREFIX || path === `${CONSOLE_PREFIX}/`;
}

/** The navigation entries: every route that is not reached from another one. */
export function navRoutes(role: ConsoleRole | undefined): ConsoleRoute[] {
  return ROUTES.filter((route) => route.navAs === undefined && routeAllows(route, role));
}

/** The navigation entry a path lights up. */
export function activeNavId(path: string): RouteId | undefined {
  const match = matchRoute(path);
  return match ? (match.route.navAs ?? match.route.id) : undefined;
}

export function routeAllows(route: ConsoleRoute, role: ConsoleRole | undefined): boolean {
  if (route.roles === "ALL") return role !== undefined;
  return role !== undefined && route.roles.includes(role);
}

export function routeTitle(route: ConsoleRoute): string {
  return copy.views[route.id].title;
}

/** The link of a route in the navigation: its first pattern, which never has a parameter. */
export function routeHref(route: ConsoleRoute): string {
  return route.patterns[0];
}

/** The link of a view by its id. */
export function pathOf(id: RouteId): string {
  const route = ROUTES.find((candidate) => candidate.id === id);
  if (!route) throw new RangeError(`no route ${id}`);
  return routeHref(route);
}
