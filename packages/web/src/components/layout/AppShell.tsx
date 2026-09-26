// Frame of every authenticated view (docs/design-brief.md §6): the navigation built from the route
// table and filtered by role, the brand line (BrandMark with the stage's brand, neutral until
// `brand.get` answers, ADR-0018), the top bar with the person and the operator's visible name, the
// simulated-time bar of the world, and the guided-tour dock beside the view.
import { useState, type ReactNode } from "react";
import { useDemoBrand, useOperatorName } from "../../context/BrandContext";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { PRODUCT_NAME, copy } from "../../copy/console";
import { Link, useRouter } from "../../lib/router";
import { type ConsoleRoute, type NavGroup, type RouteId, activeNavId, navRoutes, routeHref, routeTitle } from "../../routes";
import { PoweredByCraftech } from "../brand/Brand";
import { BrandMark } from "../brand/BrandMark";
import { Button } from "../Button";
import { TOUR_DOCK_ID, TourDock } from "./TourDock";
import { WorldClockBar } from "./WorldClockBar";

const GROUP_ORDER: readonly NavGroup[] = ["work", "team", "demo", "control"];

function NavLink({ route, active, compact }: { readonly route: ConsoleRoute; readonly active: boolean; readonly compact: boolean }) {
  const look = compact
    ? active
      ? "bg-navy text-white"
      : "bg-white text-navy hover:bg-mist"
    : active
      ? "bg-navy-soft text-white"
      : "text-mist hover:bg-navy-soft/60 hover:text-white";
  return (
    <Link to={routeHref(route)} aria-current={active ? "page" : undefined} className={`block whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${look}`}>
      {routeTitle(route)}
    </Link>
  );
}

function NavSection({ group, routes, active }: { readonly group: NavGroup; readonly routes: readonly ConsoleRoute[]; readonly active: RouteId | undefined }) {
  if (routes.length === 0) return null;
  return (
    <div>
      <p className="px-3 text-xs font-semibold uppercase tracking-widest text-slate">{copy.nav.groups[group]}</p>
      <ul className="mt-2 space-y-0.5">
        {routes.map((route) => (
          <li key={route.id}>
            <NavLink route={route} active={route.id === active} compact={false} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AppShell({ children }: { readonly children: ReactNode }) {
  const { path } = useRouter();
  const { signOut } = useSession();
  const principal = usePrincipal();
  const brand = useDemoBrand("es");
  const operatorName = useOperatorName();
  const [tourOpen, setTourOpen] = useState(false);
  const visible = navRoutes(principal.role);
  const active = activeNavId(path);
  const roleLabel = principal.role ? copy.roles[principal.role] : undefined;

  return (
    <div className="flex min-h-screen">
      <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2">
        {copy.app.skipToContent}
      </a>
      <nav aria-label={PRODUCT_NAME} className="hidden w-60 shrink-0 flex-col bg-navy px-3 py-5 md:flex">
        <div className="space-y-2 px-3">
          <BrandMark brand={brand} tone="dark" size="lg" withPoweredBy={false} />
          <p className="text-xs text-cyan">{copy.app.tagline}</p>
        </div>
        <div className="mt-8 flex-1 space-y-6">
          {GROUP_ORDER.map((group) => (
            <NavSection key={group} group={group} routes={visible.filter((route) => route.group === group)} active={active} />
          ))}
        </div>
        <div className="mt-8 space-y-3 border-t border-navy-soft px-3 pt-4">
          <p className="text-xs text-mist">{copy.app.syntheticData}</p>
          <PoweredByCraftech tone="dark" />
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-mist bg-white px-6 py-3">
          <div className="md:hidden">
            <BrandMark brand={brand} tone="light" size="sm" withPoweredBy={false} />
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-4 text-sm">
            <Button variant={tourOpen ? "primary" : "secondary"} aria-expanded={tourOpen} aria-controls={TOUR_DOCK_ID} onClick={() => setTourOpen((open) => !open)}>
              {copy.tour.open}
            </Button>
            <div className="text-right">
              <p className="font-medium text-ink">{principal.name ?? principal.email ?? roleLabel ?? PRODUCT_NAME}</p>
              <p className="text-xs text-slate">
                {roleLabel ? `${copy.app.roleLabel}: ${roleLabel}` : null}
                {roleLabel && operatorName ? " · " : null}
                {operatorName ? `${copy.app.ispLabel}: ${operatorName}` : null}
              </p>
            </div>
            <Button variant="secondary" onClick={signOut}>
              {copy.app.signOut}
            </Button>
          </div>
        </header>
        <nav aria-label={copy.app.menu} className="overflow-x-auto border-b border-mist bg-paper px-4 py-2 md:hidden">
          <ul className="flex gap-1">
            {visible.map((route) => (
              <li key={route.id}>
                <NavLink route={route} active={route.id === active} compact />
              </li>
            ))}
          </ul>
        </nav>
        <WorldClockBar />
        <div className="flex flex-1 flex-col lg:flex-row">
          <main id="content" className="min-w-0 flex-1 px-6 py-6">
            {children}
          </main>
          {tourOpen ? <TourDock onClose={() => setTourOpen(false)} /> : null}
        </div>
        <footer className="flex justify-center border-t border-mist px-6 py-3 md:hidden">
          <PoweredByCraftech tone="light" />
        </footer>
      </div>
    </div>
  );
}
