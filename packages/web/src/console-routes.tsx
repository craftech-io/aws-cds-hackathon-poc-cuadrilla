// The authenticated console: the view of the route inside the shell, with the no-access, not-found
// and forbidden screens. Loaded lazily by app.tsx, so the landing and the login do not download it.
// Each view is `views/<route id>/view.tsx` (lib/view-registry.ts); a route whose view does not exist
// yet shows its placeholder, so navigation, role guards and the shell work end to end from the start.
import { Suspense } from "react";
import { FullScreenMessage } from "./components/FullScreenMessage";
import { AppShell } from "./components/layout/AppShell";
import { LoadingBlock } from "./components/RemoteBlock";
import { IspProvider } from "./context/IspContext";
import { usePrincipal, useSession } from "./context/SessionContext";
import { WorldClockProvider } from "./context/WorldClockContext";
import { copy } from "./copy/console";
import { Link, Redirect, useRouter } from "./lib/router";
import { VIEWS } from "./lib/view-registry";
import { CONSOLE_HOME, type RouteMatch, isConsoleRoot, matchRoute, routeAllows } from "./routes";
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

function ConsoleView({ match }: { readonly match: RouteMatch }) {
  const View = VIEWS.component(match.route.id);
  if (!View) return <PlaceholderView id={match.route.id} />;
  return (
    <Suspense fallback={<LoadingBlock />}>
      <View params={match.params} />
    </Suspense>
  );
}

export default function ConsoleRoutes() {
  const { path } = useRouter();
  const { signOut } = useSession();
  const principal = usePrincipal();
  if (!principal.ispId) return <NoAccess onSignOut={signOut} />;
  if (isConsoleRoot(path)) return <Redirect to={CONSOLE_HOME} />;

  const match = matchRoute(path);
  if (!match) return <NotFound />;
  if (!routeAllows(match.route, principal.role)) return <Forbidden />;

  return (
    <IspProvider ispId={principal.ispId}>
      <WorldClockProvider>
        <AppShell>
          <ConsoleView match={match} />
        </AppShell>
        <SecurityPrompts />
      </WorldClockProvider>
    </IspProvider>
  );
}
