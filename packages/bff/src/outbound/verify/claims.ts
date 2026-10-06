// Does an agent's text state a policy or a procedure (`CP-CITATION`, docs/design-brief.md §5.7 rule 15)?
// A reply that does has to cite a section `search_procedures` returned in the same turn; one that only
// asks for a photo, confirms a step or greets does not. The detector is deterministic and errs toward
// "claims" only on the forms a policy or a procedure takes in the manual:
//
//   money        charges, costs, payments, invoices, prices, discounts ("se cobra", "sin costo")
//   permission   what is allowed, forbidden, required or authorized
//   limits       a bound with a unit ("hasta 15 m", "mínimo −25 dBm", "más de 3 pasos") or a range
//   steps        a technical action on the equipment in the imperative ("limpia el conector", "cambia el cordón")
//   reference    the manual or a procedure named as the source ("según el manual", "el procedimiento")
//
// Patterns run over `normalizeForMatch` (no accents, lower case, no punctuation).
import { normalizeForMatch } from "../../copy/helpers";

export type ClaimKind = "money" | "permission" | "limit" | "step" | "reference";

const CLAIMS: readonly (readonly [ClaimKind, RegExp])[] = [
  ["money", /\b(?:cobr\w*|costo\w*|cargo\w*|factur\w*|pag(?:o|os|a|ar|ue)\b|precio\w*|gratis|descuento\w*|tarifa\w*|bonifica\w*|reembols\w*)/],
  ["permission", /\b(?:permitid\w*|se permite|prohibid\w*|obligatori\w*|autorizad\w*|no esta permitido|no se permite|no se debe|no debes|nunca debes)\b/],
  ["limit", /\b(?:hasta|maximo|minimo|mas de|menos de|entre|rango)\b(?: \w+){0,3}? \d+(?: \d+)? ?(?:m|metros|dbm|db|minutos|min|horas|dias|pasos|intentos|nm)\b/],
  ["limit", /\brango de aceptacion\b|\bfuera de rango\b|\bdentro del rango\b/],
  ["step", /\b(?:limpia|conecta|desconecta|reconecta|reinicia|cambia|reemplaza|fusiona|empalma|enrolla|retira|coloca|sujeta|verifica que|revisa que)\b(?: \w+){0,2}? (?:el|la|los|las|un|una)\b/],
  ["reference", /\b(?:segun el manual|el manual dice|dice el manual|procedimiento|politica)\b/],
];

/** The first kind of policy or procedure statement in `text`, or `undefined`. */
export function claimKindOf(text: string): ClaimKind | undefined {
  const normalized = normalizeForMatch(text);
  for (const [kind, pattern] of CLAIMS) if (pattern.test(normalized)) return kind;
  return undefined;
}

/** Whether `text` states a policy or a procedure, so it must cite a section of the turn. */
export function claimsPolicy(text: string): boolean {
  return claimKindOf(text) !== undefined;
}
