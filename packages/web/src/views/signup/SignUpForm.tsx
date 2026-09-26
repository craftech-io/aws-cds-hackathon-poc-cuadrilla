// The `signUp` step (docs/landing-spec.md §7.3): email and password (the pool's policy as a live
// checklist), then, after an "Opcional" separator, name, company and job title (≤ 80), then the two
// consents, unchecked. "Crear cuenta" stays disabled until TERMS_PRIVACY is checked, the email looks like
// one and the AWS WAF token is at hand; CONTACT never blocks. What is typed stays in this component's
// memory; the password goes to the machine only on submit.
import { type FormEvent, useState } from "react";
import { CONTACT, type LegalLocale, TERMS_PRIVACY } from "@cuadrilla/shared/legal/consents";
import { Field, PasswordField, PasswordRules, StepHeading, SubmitButton } from "../login/form-parts";
import { ConsentField } from "./ConsentField";
import type { SignupCopy } from "./copy";
import { type SignupFormValues, canSubmit } from "./signup-model";

interface SignUpFormProps {
  readonly copy: SignupCopy;
  readonly locale: LegalLocale;
  readonly busy: boolean;
  readonly wafReady: boolean;
  readonly onSubmit: (form: SignupFormValues) => void;
}

const MAX_OPTIONAL = 80;

export function SignUpForm({ copy, locale, busy, wafReady, onSubmit }: SignUpFormProps) {
  const [form, setForm] = useState<SignupFormValues>({ email: "", password: "", name: "", company: "", jobTitle: "", terms: false, contact: false });
  const set = <K extends keyof SignupFormValues>(key: K, value: SignupFormValues[K]) => setForm((current) => ({ ...current, [key]: value }));
  const ready = canSubmit(form) && wafReady;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || busy) return;
    onSubmit(form);
  };
  return (
    <form className="space-y-4" onSubmit={submit} aria-busy={busy || !wafReady}>
      <StepHeading title={copy.title} lead={copy.lead} />
      <Field label={copy.email} type="email" autoComplete="email" inputMode="email" autoCapitalize="off" spellCheck={false} maxLength={254} value={form.email} onChange={(event) => set("email", event.target.value)} required />
      <PasswordField label={copy.password} autoComplete="new-password" value={form.password} onChange={(event) => set("password", event.target.value)} required />
      <PasswordRules password={form.password} />
      <div className="flex items-center gap-3 pt-1" role="separator" aria-label={copy.optional}>
        <span className="h-px flex-1 bg-mist" />
        <span className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.optional}</span>
        <span className="h-px flex-1 bg-mist" />
      </div>
      <Field label={copy.name} autoComplete="name" maxLength={MAX_OPTIONAL} value={form.name} onChange={(event) => set("name", event.target.value)} />
      <Field label={copy.company} autoComplete="organization" maxLength={MAX_OPTIONAL} value={form.company} onChange={(event) => set("company", event.target.value)} />
      <Field label={copy.jobTitle} autoComplete="organization-title" maxLength={MAX_OPTIONAL} value={form.jobTitle} onChange={(event) => set("jobTitle", event.target.value)} />
      <fieldset className="space-y-2 pt-1">
        <legend className="sr-only">{copy.consentsLabel}</legend>
        <ConsentField consent={TERMS_PRIVACY} locale={locale} checked={form.terms} onChange={(checked) => set("terms", checked)} />
        <ConsentField consent={CONTACT} locale={locale} checked={form.contact} onChange={(checked) => set("contact", checked)} />
      </fieldset>
      <SubmitButton busy={busy} disabled={!ready}>
        {copy.submit}
      </SubmitButton>
      <p className="text-center text-xs text-slate">{copy.note}</p>
    </form>
  );
}
