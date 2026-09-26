// One component per state of the sign-in machine. They hold what the person types (in memory,
// cleared when the step changes) and hand it to `dispatch`; the machine decides what comes next.
import { useState, type FormEvent } from "react";
import { hasOuterSpaces, looksLikeEmail, missingPasswordRules } from "../../lib/auth/credentials";
import type { AuthFlowAction } from "../../lib/auth/flow";
import { loginCopy } from "./copy";
import { CodeField, Field, LinkButton, NoticeNote, PasswordField, PasswordRules, StepHeading, SubmitButton } from "./form-parts";

export interface StepProps {
  readonly busy: boolean;
  readonly dispatch: (action: AuthFlowAction) => void;
  readonly inDrawer?: boolean;
}

function submit(handler: () => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handler();
  };
}

export function CredentialsStep({ busy, dispatch, inDrawer, fixedEmail, notice, onForgot }: StepProps & { readonly fixedEmail?: string; readonly notice?: string; readonly onForgot?: () => void }) {
  const [email, setEmail] = useState(fixedEmail ?? "");
  const [password, setPassword] = useState("");
  const onSubmit = submit(() => {
    if (!looksLikeEmail(email) || !password) return;
    dispatch({ type: "signIn", email, password });
    setPassword("");
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate={false}>
      {inDrawer ? null : <StepHeading title={loginCopy.credentials.title} lead={loginCopy.credentials.lead} />}
      {notice ? <NoticeNote>{notice}</NoticeNote> : null}
      <Field
        label={loginCopy.credentials.email}
        type="email"
        autoComplete="username"
        inputMode="email"
        autoCapitalize="off"
        spellCheck={false}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        readOnly={fixedEmail !== undefined}
        required
      />
      <PasswordField label={loginCopy.credentials.password} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      <SubmitButton busy={busy}>{loginCopy.credentials.submit}</SubmitButton>
      {onForgot ? (
        <div className="text-center">
          <LinkButton onClick={onForgot}>{loginCopy.credentials.forgot}</LinkButton>
        </div>
      ) : null}
    </form>
  );
}

/** New password + confirmation, checked against the pool's policy before anything is sent. */
function useNewPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = missingPasswordRules(password).length === 0 && !hasOuterSpaces(password) && password === confirm;
  const reset = () => {
    setPassword("");
    setConfirm("");
  };
  const fields = (label: string) => (
    <>
      <PasswordField label={label} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      <PasswordRules password={password} />
      <PasswordField label={loginCopy.password.confirm} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
      {mismatch ? <p className="text-xs text-danger">{loginCopy.password.mismatch}</p> : null}
      {hasOuterSpaces(password) ? <p className="text-xs text-danger">{loginCopy.password.outerSpaces}</p> : null}
    </>
  );
  return { password, valid, reset, fields };
}

export function NewPasswordStep({ busy, dispatch, inDrawer }: StepProps) {
  const form = useNewPassword();
  const onSubmit = submit(() => {
    if (!form.valid) return;
    dispatch({ type: "newPassword", password: form.password });
    form.reset();
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={loginCopy.newPassword.title} lead={loginCopy.newPassword.lead} inDrawer={inDrawer} />
      {form.fields(loginCopy.newPassword.field)}
      <SubmitButton busy={busy}>{loginCopy.newPassword.submit}</SubmitButton>
    </form>
  );
}

export function TotpStep({ busy, dispatch, inDrawer }: StepProps) {
  const [code, setCode] = useState("");
  const onSubmit = submit(() => {
    dispatch({ type: "totp", code });
    setCode("");
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={loginCopy.totp.title} lead={loginCopy.totp.lead} inDrawer={inDrawer} />
      <CodeField label={loginCopy.totp.code} value={code} onChange={setCode} />
      <SubmitButton busy={busy}>{loginCopy.totp.submit}</SubmitButton>
    </form>
  );
}

export function ForgotRequestStep({ busy, dispatch }: StepProps) {
  const [email, setEmail] = useState("");
  const onSubmit = submit(() => {
    if (looksLikeEmail(email)) dispatch({ type: "requestReset", email });
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={loginCopy.forgot.title} lead={loginCopy.forgot.lead} />
      <Field label={loginCopy.credentials.email} type="email" autoComplete="username" inputMode="email" autoCapitalize="off" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} required />
      <SubmitButton busy={busy}>{loginCopy.forgot.submit}</SubmitButton>
    </form>
  );
}

export function ForgotConfirmStep({ busy, dispatch, email }: StepProps & { readonly email: string }) {
  const [code, setCode] = useState("");
  const form = useNewPassword();
  const onSubmit = submit(() => {
    if (!form.valid) return;
    dispatch({ type: "confirmReset", code, password: form.password });
    form.reset();
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={loginCopy.reset.title} lead={loginCopy.reset.lead(email)} />
      <CodeField label={loginCopy.reset.code} value={code} onChange={setCode} />
      {form.fields(loginCopy.newPassword.field)}
      <SubmitButton busy={busy}>{loginCopy.reset.submit}</SubmitButton>
    </form>
  );
}
