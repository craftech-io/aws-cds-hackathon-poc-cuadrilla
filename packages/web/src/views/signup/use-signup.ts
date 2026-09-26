// React side of the sign-up machine (signup-model.ts): the state, the error of the last action and a
// busy flag; the real dependencies are built here from the build's variables (the `GuestSignup`
// client, the AWS WAF integration URL) and the session's own Cognito client and SRP for the automatic
// sign-in. The WAF token is asked for as soon as the form is on screen, so "Crear cuenta" is ready when
// the person is; the button stays disabled until then (no widget, no text unless it fails).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthServices } from "../../context/SessionContext";
import { createSignupCognitoApi } from "../../lib/auth/signup-cognito";
import { flowDeps } from "../../lib/auth/deps";
import { INITIAL_STATE, advance } from "../../lib/auth/flow";
import type { AuthEnv, SignupEnv } from "../../lib/env";
import { type WafToken, browserWafToken } from "../../lib/waf-token";
import { createSignupClient } from "./signup-client";
import { type SignupAction, type SignupDeps, type SignupErrorCode, type SignupState, INITIAL_SIGNUP, advanceSignup } from "./signup-model";

export type WafStatus = "checking" | "ready" | "failed";

export interface SignupHandle {
  readonly state: SignupState;
  readonly error: SignupErrorCode | undefined;
  readonly busy: boolean;
  readonly waf: WafStatus;
  dispatch(action: SignupAction): void;
}

export function signupDeps(auth: AuthServices, authEnv: AuthEnv, signupEnv: SignupEnv, waf: WafToken): SignupDeps {
  const client = createSignupClient(waf);
  const login = flowDeps(auth.cognito, auth.srp, { kind: "signIn" });
  return {
    start: (input) => client.start(input),
    waf,
    cognito: createSignupCognitoApi({ region: authEnv.region, clientId: signupEnv.signupClientId }),
    // The console's own SRP sign-in, run in code instead of by its form (a guest is never offered TOTP).
    signIn: async (email, password) => {
      const result = await advance(INITIAL_STATE, { type: "signIn", email, password }, login);
      return result.state.step === "done" ? result.state.tokens : undefined;
    },
    now: () => Date.now(),
  };
}

export function useSignup(auth: AuthServices | undefined, authEnv: AuthEnv | undefined, signupEnv: SignupEnv | undefined): SignupHandle {
  const waf = useMemo(() => browserWafToken(signupEnv?.wafIntegrationUrl), [signupEnv?.wafIntegrationUrl]);
  const deps = useMemo(() => (auth && authEnv && signupEnv ? signupDeps(auth, authEnv, signupEnv, waf) : undefined), [auth, authEnv, signupEnv, waf]);
  const [state, setState] = useState<SignupState>(INITIAL_SIGNUP);
  const [error, setError] = useState<SignupErrorCode | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [wafStatus, setWafStatus] = useState<WafStatus>("checking");
  const running = useRef(false);

  useEffect(() => {
    let current = true;
    waf.ready().then(
      () => current && setWafStatus("ready"),
      () => current && setWafStatus("failed"),
    );
    return () => {
      current = false;
    };
  }, [waf]);

  const dispatch = useCallback(
    (action: SignupAction) => {
      if (!deps || running.current) return;
      running.current = true;
      setBusy(true);
      void advanceSignup(state, action, deps)
        .then((transition) => {
          setState(transition.state);
          setError(transition.error);
          if (transition.error === "BROWSER_CHECK") setWafStatus("failed");
        })
        .finally(() => {
          running.current = false;
          setBusy(false);
        });
    },
    [deps, state],
  );

  return { state, error, busy, waf: wafStatus, dispatch };
}
