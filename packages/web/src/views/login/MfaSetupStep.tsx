// TOTP enrolment: the QR code of the otpauth URI (drawn locally), the secret in groups of four for
// typing by hand, and the first code that proves the app is set up. The secret lives in the
// machine's state only while this step is on screen.
import { useState, type FormEvent } from "react";
import { groupSecret, otpauthUri } from "../../lib/auth/credentials";
import type { MfaSetup } from "../../lib/auth/flow";
import { useLoginCopy } from "./auth-lang";
import { CodeField, LinkButton, StepHeading, SubmitButton } from "./form-parts";
import { QrCode } from "./QrCode";
import type { StepProps } from "./steps";

export function MfaSetupStep({ busy, dispatch, inDrawer, setup }: StepProps & { readonly setup: MfaSetup }) {
  const copy = useLoginCopy();
  const [code, setCode] = useState("");
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    dispatch({ type: "verifyMfaSetup", code });
    setCode("");
  };
  const canSkip = setup.optional && setup.via.kind === "tokens";
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <StepHeading title={copy.mfaSetup.title} lead={setup.optional ? copy.mfaSetup.leadOptional : copy.mfaSetup.leadRequired} inDrawer={inDrawer} />
      <ol className="list-decimal space-y-1 pl-5 text-sm text-ink">
        {copy.mfaSetup.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="flex flex-col items-center gap-3 rounded-card border border-mist bg-paper p-4 sm:flex-row sm:items-start">
        <QrCode value={otpauthUri(setup.secret, setup.email)} label={copy.mfaSetup.qrLabel} />
        <div className="min-w-0 text-center sm:text-left">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.mfaSetup.manualKey}</p>
          <p className="mt-1 break-all font-mono text-sm text-navy select-all">{groupSecret(setup.secret)}</p>
          <p className="mt-2 break-all text-xs text-slate">{setup.email}</p>
        </div>
      </div>
      <CodeField label={copy.mfaSetup.code} value={code} onChange={setCode} />
      <SubmitButton busy={busy}>{copy.mfaSetup.submit}</SubmitButton>
      {canSkip ? (
        <div className="text-center">
          <LinkButton onClick={() => dispatch({ type: "skipMfaSetup" })}>{copy.mfaSetup.skip}</LinkButton>
        </div>
      ) : null}
    </form>
  );
}
