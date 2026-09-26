// Top-level routing and session guard. The public pages (the landing at `/`, the login and `/join`)
// render for anyone; every other path needs an authenticated principal, and the console itself loads
// lazily (console-routes.tsx) so a visitor of the landing never downloads it.
import { Suspense, lazy } from "react";
import { FullScreenMessage } from "./components/FullScreenMessage";
import { useSession } from "./context/SessionContext";
import { copy } from "./copy/console";
import { Redirect, useRouter } from "./lib/router";
import { VIEWS } from "./lib/view-registry";
import { JOIN_PATH, LANDING_PATH, LOGIN_PATH, type PublicPageId } from "./routes";
import { LandingView } from "./views/landing/LandingView";
import { LoginView } from "./views/login/LoginView";
import { PublicPlaceholder } from "./views/placeholder/PublicPlaceholder";

const ConsoleRoutes = lazy(() => import("./console-routes"));

function PublicPage({ id }: { readonly id: PublicPageId }) {
  const View = VIEWS.component(id);
  if (!View) return <PublicPlaceholder id={id} />;
  return (
    <Suspense fallback={<FullScreenMessage title={copy.app.loading} />}>
      <View params={{}} />
    </Suspense>
  );
}

export function App() {
  const { path } = useRouter();
  const { state } = useSession();

  if (path === LANDING_PATH) return <LandingView />;
  if (path === LOGIN_PATH) return <LoginView />;
  if (path === JOIN_PATH) return <PublicPage id="join" />;
  if (state.status === "loading") return <FullScreenMessage title={copy.app.loading} />;
  if (state.status !== "authenticated") return <Redirect to={`${LOGIN_PATH}?returnTo=${encodeURIComponent(path)}`} />;

  return (
    <Suspense fallback={<FullScreenMessage title={copy.app.loading} />}>
      <ConsoleRoutes />
    </Suspense>
  );
}
