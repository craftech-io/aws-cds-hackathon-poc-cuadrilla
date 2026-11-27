// The card of the SMS code (docs/landing-spec.md §7.10): at an enrolment the number (prefilled with the
// sign-up's, editable until the code is checked), "Enviar código", the six digits and the resend with its
// countdown; at a sign-in the verified number by its last digits only, never editable. Errors above the
// form, from copy.ts.
import { type FormEvent, useEffect, useState } from "react";
import { CodeField, ErrorNote, Field, LinkButton, NoticeNote, StepHeading, SubmitButton } from "../login/form-parts";
import { RichNote } from "../signup/RichNote";
import type { PhoneCopy } from "./copy";
import { type PhoneStatus, codeOf, formatCountdown, looksLikePhone, compactPhone } from "./phone-model";
import type { PhoneStep } from "./use-phone-step";

interface CardProps {
  readonly copy: PhoneCopy;
  readonly status: PhoneStatus;
  readonly step: Pick<PhoneStep, "error" | "busy" | "resendIn">;
  onSend(phone: string | undefined): void;
  onVerify(code: string): void;
}

export function PhoneStepCard({ copy, status, step, onSend, onVerify }: CardProps) {
  const enrol = status.state === "ENROL";
  const [phone, setPhone] = useState(status.phone ?? "");
  const [editing, setEditing] = useState(enrol && !status.codeSent);
  const [code, setCode] = useState("");
  useEffect(() => {
    if (status.codeSent) setEditing(false);
  }, [status.codeSent, status.codeExpiresAt]);

  const where = enrol ? compactPhone(phone) : (status.maskedPhone ?? "");
  const canSend = step.resendIn === 0 && (!enrol || looksLikePhone(phone));
  const send = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!canSend || step.busy) return;
    onSend(enrol ? compactPhone(phone) : undefined);
  };
  const verify = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const digits = codeOf(code);
    if (digits === undefined || step.busy) return;
    onVerify(digits);
  };

  return (
    <div className="space-y-4">
      <StepHeading title={enrol ? copy.enrolTitle : copy.signInTitle} lead={enrol ? copy.enrolLead : copy.signInLead(status.maskedPhone ?? "")} />
      {step.error === undefined ? null : (
        <ErrorNote>
          <RichNote text={copy.errors[step.error]} />
        </ErrorNote>
      )}
      {status.codeSent && step.error === undefined ? <NoticeNote>{copy.sent(where)}</NoticeNote> : null}
      {enrol && editing ? (
        <form className="space-y-3" onSubmit={send}>
          <Field label={copy.phone} type="tel" autoComplete="tel" inputMode="tel" maxLength={24} placeholder="+52 55 1234 5678" value={phone} onChange={(event) => setPhone(event.target.value)} aria-describedby="phone-step-hint" required />
          <p id="phone-step-hint" className="-mt-1 text-xs text-slate">
            {copy.phoneHint}
          </p>
          <SubmitButton busy={step.busy} disabled={!canSend}>
            {step.resendIn > 0 ? copy.resendIn(formatCountdown(step.resendIn)) : copy.send}
          </SubmitButton>
        </form>
      ) : null}
      {!enrol && !status.codeSent ? (
        <form onSubmit={send}>
          <SubmitButton busy={step.busy} disabled={!canSend}>
            {step.resendIn > 0 ? copy.resendIn(formatCountdown(step.resendIn)) : copy.send}
          </SubmitButton>
        </form>
      ) : null}
      {status.codeSent ? (
        <form className="space-y-3" onSubmit={verify}>
          <CodeField label={copy.code} value={code} onChange={setCode} />
          <SubmitButton busy={step.busy} disabled={codeOf(code) === undefined}>
            {copy.verify}
          </SubmitButton>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {step.resendIn > 0 ? (
              <p className="text-sm text-slate" aria-live="polite">
                {copy.resendIn(formatCountdown(step.resendIn))}
              </p>
            ) : (
              <LinkButton onClick={() => send()}>{copy.resend}</LinkButton>
            )}
            {enrol ? <LinkButton onClick={() => setEditing(true)}>{copy.changeNumber}</LinkButton> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
