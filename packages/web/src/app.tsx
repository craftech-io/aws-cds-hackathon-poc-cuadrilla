// Top-level routing and session guard. The landing (`/`) and the login render for anyone; every
// other path needs an authenticated principal, and the console itself loads lazily
// (console-routes.tsx) so a visitor of the landing never downloads it.
import { Suspense, lazy } from "react";
import { FullScreenMessage } from "./components/FullScreenMessage";
import { useSession } from "./context/SessionContext";
import { copy } from "./copy/console";
import { Redirect, useRouter } from "./lib/router";
import { LANDING_PATH, LOGIN_PATH } from "./routes";
import { LandingView } from "./views/landing/LandingView";
import { LoginView } from "./views/login/LoginView";

const ConsoleRoutes = lazy(() => import("./console-routes"));

export function App() {
  const { path } = useRouter();
  const { state } = useSession();

  if (path === LANDING_PATH) return <LandingView />;
  if (path === LOGIN_PATH) return <LoginView />;
  if (state.status === "loading") return <FullScreenMessage title={copy.app.loading} />;
  if (state.status !== "authenticated") return <Redirect to={`${LOGIN_PATH}?returnTo=${encodeURIComponent(path)}`} />;

  return (
    <Suspense fallback={<FullScreenMessage title={copy.app.loading} />}>
      <ConsoleRoutes />
    </Suspense>
  );
}
