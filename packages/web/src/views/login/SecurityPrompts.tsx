// The two security prompts of the console, in place, without leaving the view:
//   stepUp      LOGIN_NOT_RECENT: the same person signs in again (password, and the code when TOTP is
//               on), which gives a fresh `auth_time`; the tokens are swapped and the old refresh
//               token revoked.
//   enrollTotp  the optional TOTP: associate a software token with the session's access token,
//               scan, verify, make it the preferred factor. Never offered to a judge.
// Opened from ApiErrorNotice through the session context; mounted once by app.tsx.
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Drawer } from "../../components/Drawer";
import { useSession } from "../../context/SessionContext";
import { flowDeps } from "../../lib/auth/deps";
import type { AuthFlowDeps, AuthFlowState } from "../../lib/auth/flow";
import { AuthFlowPanel } from "./AuthFlowPanel";
import { loginCopy } from "./copy";
import { ErrorNote, NoticeNote } from "./form-parts";
import { useAuthFlow } from "./use-auth-flow";

function Finished({ text, onClose }: { readonly text: string; readonly onClose: () => void }) {
  return (
    <div className="space-y-4">
      <NoticeNote>{text}</NoticeNote>
      <Button onClick={onClose}>{loginCopy.close}</Button>
    </div>
  );
}

function StepUp({ onClose }: { readonly onClose: () => void }) {
  const { state, auth, completeSignIn } = useSession();
  const principal = state.status === "authenticated" ? state.principal : undefined;
  const previous = state.status === "authenticated" ? state.tokens : undefined;
  const [finished, setFinished] = useState(false);
  const deps = useMemo(
    () => (auth && principal?.email ? flowDeps(auth.cognito, auth.srp, { kind: "stepUp", sub: principal.sub, email: principal.email }) : undefined),
    [auth, principal?.sub, principal?.email],
  );
  const flow = useAuthFlow(deps, (done) => {
    if (auth && previous?.refreshToken) void auth.cognito.revoke(previous.refreshToken).catch(() => undefined);
    completeSignIn(done.tokens);
    setFinished(true);
  });

  if (finished) return <Finished text={loginCopy.stepUp.done} onClose={onClose} />;
  if (!deps || !principal?.email) return <ErrorNote>{loginCopy.errors.UNAVAILABLE}</ErrorNote>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate">{loginCopy.stepUp.lead}</p>
      <AuthFlowPanel flow={flow} fixedEmail={principal.email} inDrawer />
    </div>
  );
}

function EnrollFlow({ deps, initial, onDone }: { readonly deps: AuthFlowDeps; readonly initial: AuthFlowState; readonly onDone: () => void }) {
  const flow = useAuthFlow(deps, onDone, initial);
  return <AuthFlowPanel flow={flow} inDrawer />;
}

function Enroll({ onClose }: { readonly onClose: () => void }) {
  const { state, auth } = useSession();
  const tokens = state.status === "authenticated" ? state.tokens : undefined;
  const email = state.status === "authenticated" ? (state.principal.email ?? state.principal.sub) : "";
  const [initial, setInitial] = useState<AuthFlowState | "failed" | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [finished, setFinished] = useState(false);
  const deps = useMemo(() => (auth ? flowDeps(auth.cognito, auth.srp, { kind: "signIn" }) : undefined), [auth]);
  // Every AssociateSoftwareToken issues a new secret and voids the previous one: one call per attempt,
  // even under StrictMode's double effects.
  const requested = useRef(-1);

  useEffect(() => {
    if (!auth || !tokens || requested.current === attempt) return;
    requested.current = attempt;
    auth.cognito
      .associateSoftwareToken({ accessToken: tokens.accessToken })
      .then(({ secretCode }) => setInitial({ step: "mfaSetup", setup: { email, secret: secretCode, optional: false, via: { kind: "tokens", tokens } } }))
      .catch(() => setInitial("failed"));
  }, [auth, tokens, email, attempt]);

  if (finished) return <Finished text={loginCopy.enroll.done} onClose={onClose} />;
  if (initial === "failed" || !deps) {
    return (
      <div className="space-y-4">
        <ErrorNote>{loginCopy.enroll.unavailable}</ErrorNote>
        <Button
          variant="secondary"
          onClick={() => {
            setInitial(undefined);
            setAttempt((value) => value + 1);
          }}
        >
          {loginCopy.enroll.retry}
        </Button>
      </div>
    );
  }
  if (!initial) return <p className="text-sm text-slate">{loginCopy.working}</p>;
  return <EnrollFlow deps={deps} initial={initial} onDone={() => setFinished(true)} />;
}

export function SecurityPrompts() {
  const { prompt, closePrompt } = useSession();
  if (!prompt) return null;
  const title = prompt === "stepUp" ? loginCopy.stepUp.title : loginCopy.enroll.title;
  return (
    <Drawer open title={title} onClose={closePrompt} closeLabel={loginCopy.close}>
      {prompt === "stepUp" ? <StepUp onClose={closePrompt} /> : <Enroll onClose={closePrompt} />}
    </Drawer>
  );
}
