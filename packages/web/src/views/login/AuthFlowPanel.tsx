// The sign-in machine on screen: one step component per state, the error of the last step and the
// way back to the start. Used by the login page and by the step-up drawer.
import type { AuthFlowHandle } from "./use-auth-flow";
import { loginCopy } from "./copy";
import { ErrorNote, LinkButton } from "./form-parts";
import { MfaSetupStep } from "./MfaSetupStep";
import { CredentialsStep, ForgotConfirmStep, ForgotRequestStep, NewPasswordStep, TotpStep } from "./steps";

interface AuthFlowPanelProps {
  readonly flow: AuthFlowHandle;
  /** Step-up: the email is the session's and cannot change. */
  readonly fixedEmail?: string;
  readonly inDrawer?: boolean;
  /** Shown above the credentials when nothing else is (e.g. "the session expired"). */
  readonly credentialsNotice?: string;
}

export function AuthFlowPanel({ flow, fixedEmail, inDrawer = false, credentialsNotice }: AuthFlowPanelProps) {
  const { state, error, busy, dispatch } = flow;
  const common = { busy, dispatch, inDrawer };
  const restart = <LinkButton onClick={() => dispatch({ type: "restart" })}>{state.step === "totp" ? loginCopy.otherUser : loginCopy.back}</LinkButton>;

  let body;
  switch (state.step) {
    case "credentials": {
      const notice = state.notice === "passwordReset" ? loginCopy.credentials.passwordReset : credentialsNotice;
      body = (
        <CredentialsStep
          {...common}
          {...(fixedEmail !== undefined ? { fixedEmail } : {})}
          {...(notice !== undefined ? { notice } : {})}
          {...(fixedEmail === undefined ? { onForgot: () => dispatch({ type: "forgot" }) } : {})}
        />
      );
      break;
    }
    case "newPassword":
      body = <NewPasswordStep {...common} />;
      break;
    case "totp":
      body = <TotpStep {...common} />;
      break;
    case "mfaSetup":
      body = <MfaSetupStep {...common} setup={state.setup} />;
      break;
    case "forgotRequest":
      body = <ForgotRequestStep {...common} />;
      break;
    case "forgotConfirm":
      body = <ForgotConfirmStep {...common} email={state.email} />;
      break;
    case "done":
      body = null;
      break;
  }

  // The same step component can come back with a fresh state (a new challenge): re-mount it.
  const key = state.step === "credentials" ? `credentials-${state.notice ?? ""}` : state.step;
  return (
    <div className="space-y-4">
      {error ? <ErrorNote>{loginCopy.errors[error]}</ErrorNote> : null}
      <div key={key}>{body}</div>
      {state.step !== "credentials" && state.step !== "done" && !(inDrawer && state.step === "mfaSetup") ? <div className="text-center">{restart}</div> : null}
    </div>
  );
}
