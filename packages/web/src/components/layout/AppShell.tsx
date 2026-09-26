// Frame of every authenticated view: sidebar navigation built from the route table and filtered
// by role, top bar with the principal and the operator, and the brand line (BrandMark: neutral
// "Cuadrilla · Powered by Craftech" until the stage's brand is loaded, ADR-0018). WP-11 adds the
// simulated-time bar and WP-42 the guided tour panel (docs/design-brief.md §6).
import type { ReactNode } from "react";
import { useIsp } from "../../context/IspContext";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { copy, PRODUCT_NAME } from "../../copy/console";
import { CuadrillaWordmark, PoweredByCraftech } from "../brand/Brand";
import { BrandMark } from "../brand/BrandMark";
import { Link, useRouter } from "../../lib/router";
import { ROUTES, routeAllows, routeTitle, type ConsoleRoute, type NavGroup } from "../../routes";
import { Button } from "../Button";

const GROUP_ORDER: readonly NavGroup[] = ["work", "team", "demo", "control"];

function isActive(route: ConsoleRoute, path: string): boolean {
  return path === route.path || path.startsWith(`${route.path}/`);
}

function NavSection({ group, routes, path }: { readonly group: NavGroup; readonly routes: readonly ConsoleRoute[]; readonly path: string }) {
  if (routes.length === 0) return null;
  return (
    <div>
      <p className="px-3 text-xs font-semibold uppercase tracking-widest text-slate">{copy.nav.groups[group]}</p>
      <ul className="mt-2 space-y-0.5">
        {routes.map((route) => {
          const active = isActive(route, path);
          return (
            <li key={route.id}>
              <Link
                to={route.path}
                aria-current={active ? "page" : undefined}
                className={`block rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active ? "bg-navy-soft text-white" : "text-mist hover:bg-navy-soft/60 hover:text-white"
                }`}
              >
                {routeTitle(route)}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AppShell({ children }: { readonly children: ReactNode }) {
  const { path } = useRouter();
  const { signOut } = useSession();
  const principal = usePrincipal();
  const { ispId } = useIsp();
  const visible = ROUTES.filter((route) => routeAllows(route, principal.role));

  return (
    <div className="flex min-h-screen">
      <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2">
        {copy.app.skipToContent}
      </a>
      <nav aria-label={PRODUCT_NAME} className="hidden w-60 shrink-0 flex-col bg-navy px-3 py-5 md:flex">
        <div className="space-y-2 px-3">
          <p>
            <BrandMark tone="dark" size="lg" withPoweredBy={false} />
          </p>
          <p className="text-xs text-cyan">{copy.app.tagline}</p>
        </div>
        <div className="mt-8 flex-1 space-y-6">
          {GROUP_ORDER.map((group) => (
            <NavSection key={group} group={group} routes={visible.filter((route) => route.group === group)} path={path} />
          ))}
        </div>
        <div className="mt-8 space-y-3 border-t border-navy-soft px-3 pt-4">
          <p className="text-xs text-mist">{copy.app.syntheticData}</p>
          <PoweredByCraftech tone="dark" />
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-mist bg-white px-6 py-3">
          <div className="flex shrink-0 items-center gap-2 md:hidden">
            <CuadrillaWordmark tone="light" size="sm" />
          </div>
          <div className="ml-auto flex items-center gap-4 text-sm">
            <div className="text-right">
              <p className="font-medium text-ink">{principal.name ?? principal.email ?? principal.sub}</p>
              <p className="text-xs text-slate">
                {copy.app.roleLabel}: {principal.role ? copy.roles[principal.role] : "—"} · {copy.app.ispLabel}: {ispId}
              </p>
            </div>
            <Button variant="secondary" onClick={signOut}>
              {copy.app.signOut}
            </Button>
          </div>
        </header>
        <main id="content" className="flex-1 px-6 py-6">
          {children}
        </main>
        <footer className="flex justify-center border-t border-mist px-6 py-3 md:hidden">
          <PoweredByCraftech tone="light" />
        </footer>
      </div>
    </div>
  );
}
