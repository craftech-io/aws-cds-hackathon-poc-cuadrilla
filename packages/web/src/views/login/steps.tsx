// One component per state of the sign-in machine. They hold what the person types (in memory,
// cleared when the step changes) and hand it to `dispatch`; the machine decides what comes next.
import { useState, type FormEvent } from "react";
import { hasOuterSpaces, looksLikeEmail, looksLikeSignInId, missingPasswordRules } from "../../lib/auth/credentials";
import type { AuthFlowAction } from "../../lib/auth/flow";
import { useLoginCopy } from "./auth-lang";
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

export function CredentialsStep({
  busy,
  dispatch,
  inDrawer,
  fixedEmail,
  initialEmail,
  notice,
  onForgot,
}: StepProps & { readonly fixedEmail?: string; readonly initialEmail?: string; readonly notice?: string; readonly onForgot?: () => void }) {
  const copy = useLoginCopy();
  const [email, setEmail] = useState(fixedEmail ?? initialEmail ?? "");
  const [password, setPassword] = useState("");
  const onSubmit = submit(() => {
    if (!looksLikeSignInId(email) || !password) return;
    dispatch({ type: "signIn", email, password });
    setPassword("");
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate={false}>
      {inDrawer ? null : <StepHeading title={copy.credentials.title} lead={copy.credentials.lead} />}
      {notice ? <NoticeNote>{notice}</NoticeNote> : null}
      <Field
        label={copy.credentials.signInId}
        type="text"
        autoComplete="username"
        inputMode="email"
        autoCapitalize="off"
        spellCheck={false}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        readOnly={fixedEmail !== undefined}
        required
      />
      <PasswordField label={copy.credentials.password} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      <SubmitButton busy={busy}>{copy.credentials.submit}</SubmitButton>
      {onForgot ? (
        <div className="text-center">
          <LinkButton onClick={onForgot}>{copy.credentials.forgot}</LinkButton>
        </div>
      ) : null}
    </form>
  );
}

/** New password + confirmation, checked against the pool's policy before anything is sent. */
function useNewPassword() {
  const copy = useLoginCopy();
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
      <PasswordField label={copy.password.confirm} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
      {mismatch ? <p className="text-xs text-danger">{copy.password.mismatch}</p> : null}
      {hasOuterSpaces(password) ? <p className="text-xs text-danger">{copy.password.outerSpaces}</p> : null}
    </>
  );
  return { password, valid, reset, fields };
}

export function NewPasswordStep({ busy, dispatch, inDrawer }: StepProps) {
  const copy = useLoginCopy();
  const form = useNewPassword();
  const onSubmit = submit(() => {
    if (!form.valid) return;
    dispatch({ type: "newPassword", password: form.password });
    form.reset();
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={copy.newPassword.title} lead={copy.newPassword.lead} inDrawer={inDrawer} />
      {form.fields(copy.newPassword.field)}
      <SubmitButton busy={busy}>{copy.newPassword.submit}</SubmitButton>
    </form>
  );
}

export function TotpStep({ busy, dispatch, inDrawer }: StepProps) {
  const copy = useLoginCopy();
  const [code, setCode] = useState("");
  const onSubmit = submit(() => {
    dispatch({ type: "totp", code });
    setCode("");
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={copy.totp.title} lead={copy.totp.lead} inDrawer={inDrawer} />
      <CodeField label={copy.totp.code} value={code} onChange={setCode} />
      <SubmitButton busy={busy}>{copy.totp.submit}</SubmitButton>
    </form>
  );
}

export function ForgotRequestStep({ busy, dispatch }: StepProps) {
  const copy = useLoginCopy();
  const [email, setEmail] = useState("");
  const onSubmit = submit(() => {
    if (looksLikeEmail(email)) dispatch({ type: "requestReset", email });
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={copy.forgot.title} lead={copy.forgot.lead} />
      <Field label={copy.credentials.email} type="email" autoComplete="username" inputMode="email" autoCapitalize="off" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} required />
      <SubmitButton busy={busy}>{copy.forgot.submit}</SubmitButton>
    </form>
  );
}

export function ForgotConfirmStep({ busy, dispatch, email }: StepProps & { readonly email: string }) {
  const copy = useLoginCopy();
  const [code, setCode] = useState("");
  const form = useNewPassword();
  const onSubmit = submit(() => {
    if (!form.valid) return;
    dispatch({ type: "confirmReset", code, password: form.password });
    form.reset();
  });
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={copy.reset.title} lead={copy.reset.lead(email)} />
      <CodeField label={copy.reset.code} value={code} onChange={setCode} />
      {form.fields(copy.newPassword.field)}
      <SubmitButton busy={busy}>{copy.reset.submit}</SubmitButton>
    </form>
  );
}
