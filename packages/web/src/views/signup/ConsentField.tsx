// One consent of the sign-up (ADR-0026): a checkbox that starts unchecked and its text, exactly as
// packages/shared/src/legal/consents.ts writes it (the version the BFF validates), with the inline
// links of the text to the legal pages, which open in a new tab so the form keeps what was typed.
// The whole row is the checkbox's label: a target of at least 44 px.
import { useId } from "react";
import { type ConsentDefinition, type LegalLocale, consentSegments } from "@cuadrilla/shared/legal/consents";

interface ConsentFieldProps {
  readonly consent: ConsentDefinition;
  readonly locale: LegalLocale;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

export function ConsentField({ consent, locale, checked, onChange }: ConsentFieldProps) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        required={consent.required}
        className="mt-0.5 h-5 w-5 shrink-0 accent-navy"
      />
      <label htmlFor={id} className="text-sm leading-snug text-ink">
        {consentSegments(consent, locale).map((segment, index) =>
          "href" in segment ? (
            <a key={index} href={segment.href} target="_blank" rel="noopener" className="font-semibold text-cyan-deep underline underline-offset-2 hover:text-navy">
              {segment.text}
            </a>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </label>
    </div>
  );
}
