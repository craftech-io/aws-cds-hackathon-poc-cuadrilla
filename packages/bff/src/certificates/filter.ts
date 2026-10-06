// Step 2 of the certificate (docs/architecture.md §11, FL-053): every free-text field goes through the
// masker (lib/mask.ts, all kinds: emails, phones, CLABE, cards, CURP, RFC) and then through G3. A G3
// block (a card number) aborts the certificate: the caller opens the `OTHER` case. Codes the system
// generates (order number, serial, class, instants) are not free text and are left as they are.
import { maskSensitive, MASK_KINDS, type MaskKind } from "../lib/mask";
import { CertificateContent } from "./content";
import type { G3Port } from "./g3";

export type FilterOutcome =
  | { readonly ok: true; readonly content: CertificateContent; readonly masked: readonly MaskKind[]; readonly g3: "NONE" | "ANONYMIZED" | "SKIPPED" }
  | { readonly ok: false; readonly reason: "G3_BLOCKED"; readonly entities: readonly string[] };

/** The free-text fields of a content, in a fixed order (what is masked and sent to G3). */
export function freeTextFields(content: CertificateContent): string[] {
  return [
    content.installerName,
    content.customer.firstName,
    content.customer.addressLine,
    content.customer.neighborhood,
    content.plan,
    ...content.items.map((item) => item.validatedBy ?? ""),
  ];
}

/** The content with its free-text fields replaced, in the order of `freeTextFields`. */
function withFields(content: CertificateContent, fields: readonly string[]): CertificateContent {
  const at = (index: number): string => fields[index] ?? "";
  return CertificateContent.parse({
    ...content,
    installerName: at(0),
    customer: { firstName: at(1), addressLine: at(2), neighborhood: at(3) },
    plan: at(4),
    items: content.items.map((item, index) => {
      const { validatedBy: original, ...rest } = item;
      const value = at(5 + index);
      return original === undefined || value === "" ? rest : { ...rest, validatedBy: value };
    }),
  });
}

/**
 * Masks every free-text field and passes them through G3 (`g3` absent only for a historical
 * certificate of the seed, whose content is synthetic and was checked when the seed was generated).
 */
export async function filterCertificateContent(content: CertificateContent, g3: G3Port | undefined): Promise<FilterOutcome> {
  const masked = new Set<MaskKind>();
  const fields = freeTextFields(content).map((text) => {
    const result = maskSensitive(text, MASK_KINDS);
    for (const kind of result.kinds) masked.add(kind);
    return result.text;
  });
  if (g3 === undefined) return { ok: true, content: withFields(content, fields), masked: [...masked], g3: "SKIPPED" };
  const outcome = await g3.apply(fields);
  if (outcome.action === "BLOCKED") return { ok: false, reason: "G3_BLOCKED", entities: outcome.entities };
  return { ok: true, content: withFields(content, outcome.texts), masked: [...masked], g3: outcome.action };
}
