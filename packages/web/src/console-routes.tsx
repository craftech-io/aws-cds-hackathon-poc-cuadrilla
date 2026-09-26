// The authenticated console: the view of the route inside the shell, with the no-access,
// not-found and forbidden screens. Loaded lazily by app.tsx, so the landing and the login do not
// download the views.
import { FullScreenMessage } from "./components/FullScreenMessage";
import { AppShell } from "./components/layout/AppShell";
import { IspProvider } from "./context/IspContext";
import { usePrincipal, useSession } from "./context/SessionContext";
import { copy } from "./copy/console";
import { Link, useRouter } from "./lib/router";
import { CONSOLE_HOME, ROUTES, routeAllows, type ConsoleRoute } from "./routes";
import { SecurityPrompts } from "./views/login/SecurityPrompts";
import { PlaceholderView } from "./views/placeholder/PlaceholderView";

function BackHome() {
  return (
    <Link to={CONSOLE_HOME} className="text-sm font-semibold text-cyan-deep underline">
      {copy.errors.backHome}
    </Link>
  );
}

function NotFound() {
  return (
    <FullScreenMessage title={copy.errors.notFoundTitle} lead={copy.errors.notFoundLead}>
      <BackHome />
    </FullScreenMessage>
  );
}

function Forbidden() {
  return (
    <FullScreenMessage title={copy.errors.forbiddenTitle} lead={copy.errors.forbiddenLead}>
      <BackHome />
    </FullScreenMessage>
  );
}

function NoAccess({ onSignOut }: { readonly onSignOut: () => void }) {
  return (
    <FullScreenMessage title={copy.login.noAccessTitle} lead={copy.login.noAccessLead}>
      <button type="button" className="text-sm font-semibold text-cyan-deep underline" onClick={onSignOut}>
        {copy.app.signOut}
      </button>
    </FullScreenMessage>
  );
}

/** The route that owns a path: its own path or anything under it (`/app/orders/wo-24817`). */
export function routeOf(path: string): ConsoleRoute | undefined {
  return ROUTES.find((route) => path === route.path || path.startsWith(`${route.path}/`));
}

export default function ConsoleRoutes() {
  const { path } = useRouter();
  const { signOut } = useSession();
  const principal = usePrincipal();
  if (!principal.ispId) return <NoAccess onSignOut={signOut} />;

  const route = routeOf(path);
  if (!route) return <NotFound />;
  if (!routeAllows(route, principal.role)) return <Forbidden />;

  return (
    <IspProvider ispId={principal.ispId}>
      <AppShell>
        <PlaceholderView id={route.id} />
      </AppShell>
      <SecurityPrompts />
    </IspProvider>
  );
}
