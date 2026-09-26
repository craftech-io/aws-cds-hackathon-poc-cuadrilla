// `/login`: the console's own sign-in, "Cuadrilla · Powered by Craftech", against the
// Cognito pool (USER_SRP_AUTH and its challenges, lib/auth/flow.ts). A finished sign-in stores the
// tokens in the session and lands on `returnTo`.
import { useMemo } from "react";
import { CuadrillaWordmark, PoweredByCraftech } from "../../components/brand/Brand";
import { useSession } from "../../context/SessionContext";
import { copy } from "../../copy/console";
import { flowDeps } from "../../lib/auth/deps";
import { safeReturnTo } from "../../lib/auth/tokens";
import { Redirect, useRouter } from "../../lib/router";
import { CONSOLE_HOME, LOGIN_PATH } from "../../routes";
import { AuthFlowPanel } from "./AuthFlowPanel";
import { loginCopy } from "./copy";
import { useAuthFlow } from "./use-auth-flow";

function BrandPanel() {
  return (
    <section className="relative flex flex-col justify-between gap-10 overflow-hidden bg-navy px-6 py-8 text-white sm:px-10 lg:min-h-screen lg:py-12">
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-navy-soft/60" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-cyan/10" />
      <div className="relative">
        <CuadrillaWordmark tone="dark" size="xl" />
        <p className="mt-3 text-sm text-cyan-soft">{loginCopy.panel.tagline}</p>
      </div>
      <div className="relative hidden max-w-md lg:block">
        <p className="text-4xl font-semibold leading-tight">{loginCopy.panel.title}</p>
        <p className="mt-4 text-base text-mist">{loginCopy.panel.lead}</p>
        <ul className="mt-6 space-y-2 text-sm text-cyan-soft">
          {loginCopy.panel.points.map((point) => (
            <li key={point} className="flex items-center gap-2">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-cyan" />
              {point}
            </li>
          ))}
        </ul>
      </div>
      <div className="relative hidden lg:block">
        <PoweredByCraftech tone="dark" />
      </div>
    </section>
  );
}

function Unconfigured({ missing }: { readonly missing: readonly string[] }) {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold text-navy">{copy.login.unconfiguredTitle}</h1>
      <p className="text-sm text-slate">{copy.login.unconfiguredLead}</p>
      <ul className="list-disc pl-5 font-mono text-xs text-danger">
        {missing.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </div>
  );
}

export function LoginView() {
  const { state, auth, completeSignIn } = useSession();
  const { search } = useRouter();
  const returnTo = safeReturnTo(search.get("returnTo"), LOGIN_PATH, CONSOLE_HOME);
  const deps = useMemo(() => (auth ? flowDeps(auth.cognito, auth.srp, { kind: "signIn" }) : undefined), [auth]);
  const flow = useAuthFlow(deps, (done) => completeSignIn(done.tokens));

  if (state.status === "authenticated") return <Redirect to={returnTo} />;

  let content;
  if (state.status === "unconfigured") content = <Unconfigured missing={state.missing} />;
  else if (state.status === "loading") content = <p className="text-sm text-slate">{copy.app.loading}</p>;
  else {
    const expired = state.reason === "expired" ? loginCopy.credentials.sessionExpired : undefined;
    content = <AuthFlowPanel flow={flow} {...(expired !== undefined ? { credentialsNotice: expired } : {})} />;
  }

  return (
    <div className="min-h-screen bg-paper lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <BrandPanel />
      <main className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="rounded-card bg-white p-6 shadow-card sm:p-8">{content}</div>
          <p className="mt-4 text-center text-xs text-slate">{loginCopy.credentials.hint}</p>
          <footer className="mt-8 flex flex-col items-center gap-3 text-xs text-slate">
            <PoweredByCraftech tone="light" className="lg:hidden" />
            <nav className="flex gap-4">
              <a className="hover:text-navy hover:underline" href="/legal/privacy.html">
                {loginCopy.legal.privacy}
              </a>
              <a className="hover:text-navy hover:underline" href="/legal/terms.html">
                {loginCopy.legal.terms}
              </a>
            </nav>
          </footer>
        </div>
      </main>
    </div>
  );
}
