// The `confirmCode` step (docs/landing-spec.md §7.4): the 6-digit code of the email, "Reenviar código"
// and the way back to another email. Confirming signs the person in by itself (the machine keeps the
// password in memory for that) and the button says "Un momento…" meanwhile.
import { type FormEvent, useState } from "react";
import { CodeField, LinkButton, NoticeNote, StepHeading, SubmitButton } from "../login/form-parts";
import type { SignupCopy } from "./copy";
import type { SignupAction } from "./signup-model";

interface ConfirmCodeStepProps {
  readonly copy: SignupCopy;
  readonly email: string;
  readonly resent: boolean;
  readonly busy: boolean;
  readonly dispatch: (action: SignupAction) => void;
}

export function ConfirmCodeStep({ copy, email, resent, busy, dispatch }: ConfirmCodeStepProps) {
  const [code, setCode] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    dispatch({ type: "confirm", code });
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <StepHeading title={copy.confirm.title} lead={copy.confirm.lead(email)} />
      {resent ? <NoticeNote>{copy.confirm.resent}</NoticeNote> : null}
      <CodeField label={copy.confirm.code} value={code} onChange={setCode} />
      <SubmitButton busy={busy}>{copy.confirm.submit}</SubmitButton>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <LinkButton onClick={() => dispatch({ type: "resend" })}>{copy.confirm.resend}</LinkButton>
        <LinkButton onClick={() => dispatch({ type: "back" })}>{copy.confirm.back}</LinkButton>
      </div>
    </form>
  );
}
