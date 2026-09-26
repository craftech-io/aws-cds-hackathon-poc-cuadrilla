// The six WhatsApp `UTILITY` templates in `es_MX` (docs/architecture-integrations.md §4.5). The text
// is registered with Meta and is the same in both brand modes, so none of them names the operator
// (the sender is the display name "Craftech"). Meta's rules, checked by copy.test.ts: no body starts
// or ends with a parameter, at least three fixed words per parameter, one synthetic example per
// parameter, quick-reply buttons of at most 25 characters. Parameters are built by code (never free
// text of the model), carry no line breaks and go through G3 before rendering. The same body is the
// interactive message of plan B, with the same buttons, inside an open window.
import { TemplateName, type WaButtonAction } from "@cuadrilla/shared";
import { buttonTitle } from "./buttons";
import { fillPlaceholders } from "./helpers";

export const TEMPLATE_LANGUAGE = "es_MX";
export const TEMPLATE_CATEGORY = "UTILITY";

/** Synthetic sample of the document header of `acta_instalacion`, in the `Seed` bucket (WP-18). */
export const CERTIFICATE_TEMPLATE_SAMPLE_KEY = "templates/acta-muestra.pdf";

export interface TemplateParam {
  /** What code puts in the parameter. */
  readonly description: string;
  /** Synthetic example sent to Meta in `example.body_text`. */
  readonly example: string;
}

export interface TemplateDefinition {
  readonly name: TemplateName;
  readonly language: typeof TEMPLATE_LANGUAGE;
  readonly category: typeof TEMPLATE_CATEGORY;
  /** Who receives it. */
  readonly audience: "INSTALLER" | "SUPERVISOR";
  /** Document header with its synthetic sample; only `acta_instalacion`. */
  readonly header?: { readonly format: "DOCUMENT"; readonly sampleKey: string };
  /** Body with `{{1}}`…`{{n}}`. */
  readonly body: string;
  /** One entry per placeholder, in order. */
  readonly params: readonly TemplateParam[];
  /** Quick-reply buttons, in order; each carries a nonce as payload when sent. */
  readonly buttons: readonly WaButtonAction[];
}

const CASE_PARAMS: readonly TemplateParam[] = [
  { description: "short label of the case", example: "C-0412" },
  { description: "installer's first name", example: "Rogelio" },
  { description: "work order number", example: "24818" },
  { description: "case category in words (copy caseReason)", example: "potencia fuera de rango después de 3 pasos" },
];

export const TEMPLATES: Readonly<Record<TemplateName, TemplateDefinition>> = {
  ordenes_del_dia: {
    name: "ordenes_del_dia",
    language: TEMPLATE_LANGUAGE,
    category: TEMPLATE_CATEGORY,
    audience: "INSTALLER",
    body: "Hola {{1}}, hoy tienes {{2}} instalaciones asignadas en tu ruta. La primera cita es de {{3}}. Toca Ver órdenes para recibir el detalle de cada una.",
    params: [
      { description: "installer's first name", example: "Rogelio" },
      { description: "number of work orders of the day", example: "3" },
      { description: "window of the first appointment (formatWindow)", example: "09:00 a 11:00" },
    ],
    buttons: ["VIEW_ORDERS"],
  },
  caso_escalado: {
    name: "caso_escalado",
    language: TEMPLATE_LANGUAGE,
    category: TEMPLATE_CATEGORY,
    audience: "SUPERVISOR",
    body: "Tienes un caso nuevo de tu equipo: {{1}}. El instalador {{2}} necesita apoyo en la orden {{3}} por este motivo: {{4}}. ¿Puedes tomarlo ahora?",
    params: CASE_PARAMS,
    buttons: ["TAKE_CASE", "DECLINE_CASE"],
  },
  caso_reasignado: {
    name: "caso_reasignado",
    language: TEMPLATE_LANGUAGE,
    category: TEMPLATE_CATEGORY,
    audience: "SUPERVISOR",
    body: "El supervisor de turno no respondió el caso {{1}}. El instalador {{2}} sigue esperando apoyo en la orden {{3}} por este motivo: {{4}}. ¿Puedes tomarlo ahora?",
    params: CASE_PARAMS,
    buttons: ["TAKE_CASE", "DECLINE_CASE"],
  },
  alerta_seguridad: {
    name: "alerta_seguridad",
    language: TEMPLATE_LANGUAGE,
    category: TEMPLATE_CATEGORY,
    audience: "SUPERVISOR",
    body: "Alerta de seguridad en la orden {{1}}. El instalador {{2}} reportó este riesgo: {{3}}. Ya recibió la instrucción de seguridad del manual. ¿Puedes tomarlo ahora?",
    params: [
      { description: "work order number", example: "24819" },
      { description: "installer's first name", example: "Rogelio" },
      { description: "hazard category in words (copy hazard)", example: "cable de energía dañado" },
    ],
    buttons: ["TAKE_CASE", "DECLINE_CASE"],
  },
  respuesta_supervisor: {
    name: "respuesta_supervisor",
    language: TEMPLATE_LANGUAGE,
    category: TEMPLATE_CATEGORY,
    audience: "INSTALLER",
    body: "Tu supervisor {{1}} te respondió sobre la orden {{2}}. Toca Ver respuesta para leer su mensaje completo.",
    params: [
      { description: "supervisor's first name", example: "Héctor" },
      { description: "work order number", example: "24818" },
    ],
    buttons: ["VIEW_REPLY"],
  },
  acta_instalacion: {
    name: "acta_instalacion",
    language: TEMPLATE_LANGUAGE,
    category: TEMPLATE_CATEGORY,
    audience: "INSTALLER",
    header: { format: "DOCUMENT", sampleKey: CERTIFICATE_TEMPLATE_SAMPLE_KEY },
    body: "El acta de la orden {{1}} está lista. Ya se envió al cliente y al buzón de operaciones.",
    params: [{ description: "work order number", example: "24817" }],
    buttons: [],
  },
};

/** Why a parameter value cannot go into a template, or `null` when it can (Meta rejects the rest). */
export function templateParamProblem(value: string): string | null {
  if (value.trim() === "") return "empty parameter";
  if (/[\r\n\t]/.test(value)) return "line breaks and tabs are not allowed in a parameter";
  if (/ {5,}/.test(value)) return "more than four consecutive spaces";
  if ([...value].length > 200) return "parameter longer than 200 characters";
  return null;
}

/** The body of `name` with `params`, as the simulated transport and plan B show it. */
export function renderTemplateBody(name: TemplateName, params: readonly string[]): string {
  const template = TEMPLATES[TemplateName.parse(name)];
  params.forEach((value, index) => {
    const problem = templateParamProblem(value);
    if (problem !== null) throw new Error(`${name} {{${index + 1}}}: ${problem}`);
  });
  return fillPlaceholders(template.body, params);
}

/** Titles of the template's buttons in Spanish, in order. */
export function templateButtonTitles(name: TemplateName): string[] {
  return TEMPLATES[TemplateName.parse(name)].buttons.map((action) => buttonTitle(action));
}
