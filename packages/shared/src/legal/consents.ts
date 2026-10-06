// The two consents of the own sign-up (ADR-0026, "Formulario y consentimientos"), in one place: the web
// shows these texts next to their checkboxes (docs/landing-spec.md §7.3), `signup.start` validates the
// answers against them (packages/bff/src/leads/consent.ts) and the legal pages carry the same version.
// A change of text is a NEW version (`textVersion`, YYYY-MM-DD) and the old one is never rewritten: the
// lead keeps what each visitor accepted in `consentHistory`.
//
// `TERMS_PRIVACY` names the international transfer in the checkbox itself (a consent that only lives
// behind a link is not express). Browser-safe: no Node API, zod only.
import { z } from "zod";

/** Languages of the sign-up, the auth emails and the legal pages. */
export const LEGAL_LOCALES = ["es-MX", "en"] as const;
export const LegalLocale = z.enum(LEGAL_LOCALES);
export type LegalLocale = z.infer<typeof LegalLocale>;

export const CONSENT_IDS = ["TERMS_PRIVACY", "CONTACT"] as const;
export const ConsentId = z.enum(CONSENT_IDS);
export type ConsentId = z.infer<typeof ConsentId>;

/** `YYYY-MM-DD`, a real calendar day. */
export const ConsentVersion = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "expected YYYY-MM-DD");
export type ConsentVersion = z.infer<typeof ConsentVersion>;

/** Public paths of the two legal pages (packages/web/public/legal/). */
export const LEGAL_PATHS = { terms: "/legal/terms.html", privacy: "/legal/privacy.html" } as const;

export interface ConsentLink {
  /** The words of `text` that become the link, exactly as they appear in it. */
  readonly label: string;
  readonly href: string;
}

export interface ConsentDefinition {
  readonly id: ConsentId;
  readonly textVersion: ConsentVersion;
  /** Whether the account can be created without it (`TERMS_PRIVACY` only). */
  readonly required: boolean;
  readonly text: Readonly<Record<LegalLocale, string>>;
  /** Inline links of the text, in the order they appear. */
  readonly links: Readonly<Record<LegalLocale, readonly ConsentLink[]>>;
}

/** Version in force of both consents and of the legal pages. */
export const CONSENTS_VERSION = "2026-10-06";

export const TERMS_PRIVACY: ConsentDefinition = {
  id: "TERMS_PRIVACY",
  textVersion: CONSENTS_VERSION,
  required: true,
  text: {
    "es-MX":
      "Acepto los Términos y el Aviso de privacidad de Craftech, incluida la transferencia de mis datos a Estados Unidos y a otras regiones de AWS descrita en el aviso.",
    en: "I accept Craftech's Terms and Privacy Notice, including the transfer of my data to the United States and other AWS regions described in the notice.",
  },
  links: {
    "es-MX": [
      { label: "Términos", href: LEGAL_PATHS.terms },
      { label: "Aviso de privacidad", href: LEGAL_PATHS.privacy },
    ],
    en: [
      { label: "Terms", href: LEGAL_PATHS.terms },
      { label: "Privacy Notice", href: LEGAL_PATHS.privacy },
    ],
  },
};

export const CONTACT: ConsentDefinition = {
  id: "CONTACT",
  textVersion: CONSENTS_VERSION,
  required: false,
  text: {
    "es-MX": "Acepto que Craftech me contacte por esta solución.",
    en: "I agree that Craftech may contact me about this solution.",
  },
  links: { "es-MX": [], en: [] },
};

export const CONSENTS: Readonly<Record<ConsentId, ConsentDefinition>> = { TERMS_PRIVACY, CONTACT };

/** What the form sends for one consent: the box as the visitor left it and the version it showed. */
export const ConsentAnswer = z
  .object({
    accepted: z.boolean(),
    textVersion: ConsentVersion,
  })
  .strict();
export type ConsentAnswer = z.infer<typeof ConsentAnswer>;

/** Both answers of the form, always both (an unchecked box is `accepted: false`, never absent). */
export const ConsentAnswers = z
  .object({
    TERMS_PRIVACY: ConsentAnswer,
    CONTACT: ConsentAnswer,
  })
  .strict();
export type ConsentAnswers = z.infer<typeof ConsentAnswers>;

export type ConsentSegment = { readonly text: string } | { readonly text: string; readonly href: string };

/**
 * The text of a consent cut into plain runs and link runs, for the checkbox label: joining every
 * `text` gives back the consent's text exactly, so the web never copies or rewrites it.
 */
export function consentSegments(consent: ConsentDefinition, locale: LegalLocale): ConsentSegment[] {
  const text = consent.text[locale];
  const segments: ConsentSegment[] = [];
  let cursor = 0;
  for (const link of consent.links[locale]) {
    const at = text.indexOf(link.label, cursor);
    if (at === -1) throw new RangeError(`the link "${link.label}" is not in the ${consent.id} text (${locale})`);
    if (at > cursor) segments.push({ text: text.slice(cursor, at) });
    segments.push({ text: link.label, href: link.href });
    cursor = at + link.label.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
