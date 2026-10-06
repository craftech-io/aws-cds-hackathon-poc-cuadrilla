// The controller of the leads and the channel to exercise the data rights (ADR-0027): the facts the
// privacy notice and the terms (packages/web/public/legal/) must state, in one place for their tests.
// Nothing here is invented: no tax id, no street address. A change is a new `CONSENTS_VERSION`.

export const PRIVACY_CONTROLLER = {
  name: "Craftech",
  seat: {
    "es-MX": "Ciudad Autónoma de Buenos Aires, Argentina",
    en: "Autonomous City of Buenos Aires, Argentina",
  },
  /** Privacy and data-rights mailbox. */
  mailbox: "sales@craftech.io",
  /** The alternative channel: the contact form. */
  contactUrl: "https://craftech.io/contact/",
} as const;

/** The control-body legend of Law 25.326, word for word (ADR-0027). */
export const CONTROL_BODY_LEGEND_ES =
  "La Agencia de Acceso a la Información Pública, en su carácter de Órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales.";

/** Words that mark a text as provisional; no visible legal text may carry one (ADR-0027). */
export const INTERIM_MARKERS: readonly RegExp[] = [
  /a confirmar/i,
  /en confirmaci[oó]n/i,
  /provisori[oa]/i,
  /provisional/i,
  /interin[oa]/i,
  /\binterim\b/i,
  /being confirmed/i,
  /to be confirmed/i,
  /\bTBD\b/,
  /data-pending/i,
];

/** The interim markers found in a text (their patterns), for a test to assert empty. */
export function interimMarkersIn(text: string): string[] {
  return INTERIM_MARKERS.filter((marker) => marker.test(text)).map((marker) => marker.source);
}
