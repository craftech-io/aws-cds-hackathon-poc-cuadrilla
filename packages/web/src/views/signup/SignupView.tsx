// `/signup`: the own sign-up (ADR-0025, ADR-0026, docs/landing-spec.md §7), inside the AuthShell it
// shares with the login, in Spanish or English (`?lang=`, the switch). `signUp → confirmCode → done`:
// once the code is confirmed the person is signed in by itself and lands on its portada (`/app/home`),
// where the state of its world lives; if that sign-in does not work, `/login` opens with the email
// already typed. Nobody already signed in stays here: it goes to the home of its role.
import { useEffect, useState } from "react";
import type { LegalLocale } from "@cuadrilla/shared/legal/consents";
import { useSession } from "../../context/SessionContext";
import { readAttribution, sessionStore } from "../../lib/attribution";
import { handOffEmail } from "../../lib/auth/handoff";
import { readSignupEnv } from "../../lib/env";
import { Link, Redirect, useRouter } from "../../lib/router";
import { GUEST_HOME, LOGIN_PATH, homeOf } from "../../routes";
import { AuthShell } from "../login/AuthShell";
import { AuthLangProvider, type AuthLang, authLangFromSearch, useAuthLang, withAuthLang } from "../login/auth-lang";
import { ErrorNote } from "../login/form-parts";
import { Unconfigured } from "../login/Unconfigured";
import { ConfirmCodeStep } from "./ConfirmCodeStep";
import { signupCopy } from "./copy";
import { RichNote } from "./RichNote";
import { SignUpForm } from "./SignUpForm";
import { useSignup } from "./use-signup";

const LOCALE: Readonly<Record<AuthLang, LegalLocale>> = { es: "es-MX", en: "en" };

function SignupContent() {
  const { state: session, auth, env, completeSignIn } = useSession();
  const { navigate } = useRouter();
  const { lang } = useAuthLang();
  const copy = signupCopy[lang];
  const [signupEnv] = useState(readSignupEnv);
  const handle = useSignup(auth, env, signupEnv.ok ? signupEnv.env : undefined);
  const { state, error, busy, waf, dispatch } = handle;

  useEffect(() => {
    if (state.step === "done") {
      completeSignIn(state.tokens);
      navigate(lang === "en" ? `${GUEST_HOME}?lang=en` : GUEST_HOME, { replace: true });
    } else if (state.step === "signIn") {
      handOffEmail(state.email);
      navigate(withAuthLang(LOGIN_PATH, lang), { replace: true });
    }
  }, [state, lang, completeSignIn, navigate]);

  if (session.status === "authenticated" && state.step === "signUp") return <Redirect to={homeOf(session.principal.role)} />;

  const loginPath = withAuthLang(LOGIN_PATH, lang);
  const errors = copy.errors({ login: loginPath, forgot: withAuthLang(`${LOGIN_PATH}?forgot=1`, lang) });
  const shownError = error ?? (waf === "failed" && state.step === "signUp" ? "BROWSER_CHECK" : undefined);
  const missing = [...new Set([...(session.status === "unconfigured" ? session.missing : []), ...(signupEnv.ok ? [] : signupEnv.missing)])];

  let body;
  if (missing.length > 0 || env === undefined) body = <Unconfigured missing={missing} />;
  else if (state.step === "confirmCode") body = <ConfirmCodeStep copy={copy} email={state.account.email} resent={state.notice === "codeResent"} busy={busy} dispatch={dispatch} />;
  else if (state.step === "signUp") body = <SignUpForm copy={copy} locale={LOCALE[lang]} busy={busy} wafReady={waf === "ready"} onSubmit={(form) => dispatch({ type: "submit", form, locale: LOCALE[lang], ...attributionOf() })} />;
  else body = <p className="text-sm text-slate">{copy.signingIn}</p>;

  const below =
    state.step === "signUp" ? (
      <p className="text-sm text-ink">
        {copy.haveAccount.before}
        <Link to={loginPath} className="font-semibold text-cyan-deep underline underline-offset-2 hover:text-navy">
          {copy.haveAccount.link}
        </Link>
      </p>
    ) : undefined;

  return (
    <AuthShell below={below}>
      <div className="space-y-4">
        {shownError === undefined ? null : (
          <ErrorNote>
            <RichNote text={errors[shownError]} />
          </ErrorNote>
        )}
        {body}
      </div>
    </AuthShell>
  );
}

function attributionOf() {
  const attribution = readAttribution(sessionStore());
  return attribution === undefined ? {} : { attribution };
}

export function SignupView() {
  const { search } = useRouter();
  const [lang] = useState(() => authLangFromSearch(search));
  return (
    <AuthLangProvider initial={lang}>
      <SignupContent />
    </AuthLangProvider>
  );
}
