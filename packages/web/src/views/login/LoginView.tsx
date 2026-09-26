// `/login`: the console's own sign-in against the Cognito pool (USER_SRP_AUTH and its challenges,
// lib/auth/flow.ts) inside the AuthShell it shares with the sign-up, in Spanish or English
// (`?lang=`, the switch). `?forgot=1` opens the recovery; a finished sign-up whose automatic sign-in did
// not work arrives with its email already typed (lib/auth/handoff.ts, memory only). A finished sign-in
// stores the tokens in the session and lands on `returnTo`, or on the home of its role: the guest's
// portada (`/app/home`) for a guest, the day's work orders for the operator's staff.
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/SessionContext";
import { flowDeps } from "../../lib/auth/deps";
import type { AuthFlowState } from "../../lib/auth/flow";
import { forgetHandedOffEmail, handedOffEmail } from "../../lib/auth/handoff";
import { safeReturnTo } from "../../lib/auth/tokens";
import { Link, Redirect, useRouter } from "../../lib/router";
import { LOGIN_PATH, SIGNUP_PATH, homeOf } from "../../routes";
import { AuthFlowPanel } from "./AuthFlowPanel";
import { AuthShell } from "./AuthShell";
import { Unconfigured } from "./Unconfigured";
import { AuthLangProvider, authLangFromSearch, useAuthLang, useLoginCopy, withAuthLang } from "./auth-lang";
import { useAuthFlow } from "./use-auth-flow";

function TryTheDemo() {
  const copy = useLoginCopy();
  const { lang } = useAuthLang();
  return (
    <p className="text-sm text-ink">
      {copy.credentials.tryDemo.before}
      <Link to={withAuthLang(SIGNUP_PATH, lang)} className="font-semibold text-cyan-deep underline underline-offset-2 hover:text-navy">
        {copy.credentials.tryDemo.link}
      </Link>
    </p>
  );
}

function LoginContent({ initial, initialEmail }: { readonly initial: AuthFlowState; readonly initialEmail: string | undefined }) {
  const { state, auth, completeSignIn } = useSession();
  const { search } = useRouter();
  const copy = useLoginCopy();
  const deps = useMemo(() => (auth ? flowDeps(auth.cognito, auth.srp, { kind: "signIn" }) : undefined), [auth]);
  const flow = useAuthFlow(deps, (done) => completeSignIn(done.tokens), initial);

  if (state.status === "authenticated") return <Redirect to={safeReturnTo(search.get("returnTo"), LOGIN_PATH, homeOf(state.principal.role))} />;

  let content;
  if (state.status === "unconfigured") content = <Unconfigured missing={state.missing} />;
  else if (state.status === "loading") content = <p className="text-sm text-slate">{copy.working}</p>;
  else {
    const expired = state.reason === "expired" ? copy.credentials.sessionExpired : undefined;
    content = <AuthFlowPanel flow={flow} {...(expired !== undefined ? { credentialsNotice: expired } : {})} {...(initialEmail !== undefined ? { initialEmail } : {})} />;
  }

  const below =
    flow.state.step === "credentials" ? (
      <>
        <TryTheDemo />
        <p>{copy.credentials.hint}</p>
      </>
    ) : undefined;
  return <AuthShell below={below}>{content}</AuthShell>;
}

export function LoginView() {
  const { search } = useRouter();
  // Read once per visit of the page: the query only sets the start, the handed-off email is forgotten once shown.
  const [start] = useState(() => ({
    lang: authLangFromSearch(search),
    initial: (search.get("forgot") === "1" ? { step: "forgotRequest" } : { step: "credentials" }) satisfies AuthFlowState,
    email: handedOffEmail(),
  }));
  useEffect(() => forgetHandedOffEmail(), []);
  return (
    <AuthLangProvider initial={start.lang}>
      <LoginContent initial={start.initial} initialEmail={start.email} />
    </AuthLangProvider>
  );
}
