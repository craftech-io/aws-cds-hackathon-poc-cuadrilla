// The one place that turns the `BrandConfig` secret into the demo operator's visible brand
// (ADR-0018). Nothing static names the operator: the world factory and the seed loader write
// `Isps/META.displayName` with `resolveBrand`, and the certificate, the emails, `brand.get` and the
// manual viewer read the resolved brand, never a literal.
//
//   neutral  the fictitious default operator below, labelled "ficticia"; "Cuadrilla · Powered by Craftech"
//   cobrand  the design partner from the secret; "Cuadrilla for <partner> · Powered by Craftech" and the
//            mandatory synthetic-demo notice
//
// DEFAULT_OPERATOR_NAME is the only occurrence of the fictitious name in code, seed and texts;
// copy.test.ts fails if any other file of copy/ contains it, and the seed validator imports it from here.
import type { BrandMode } from "@cuadrilla/shared";
import { BrandConfigValue } from "../lib/secret-schemas";
import { enGloss } from "./en-gloss";
import { esMX } from "./es-MX";

/** Fictitious operator of the neutral mode, checked in `Reference/NAMECHECK` (docs/seed-spec.md §12). */
export const DEFAULT_OPERATOR_NAME = "Tulvara Fibra";

export interface BilingualText {
  readonly es: string;
  readonly en: string;
}

export interface ResolvedBrand {
  readonly mode: BrandMode;
  /** Visible name of the operator: `Isps/META.displayName`, certificate, subjects and bodies. */
  readonly operatorName: string;
  /** Short name for tight places (a chip, a narrow header). */
  readonly operatorShortName: string;
  /** "Cuadrilla · Powered by Craftech" or "Cuadrilla for <partner> · Powered by Craftech". */
  readonly brandLine: string;
  /** Tag after the operator's name in subjects and headers: "ficticia" or "demo sintética". */
  readonly tag: BilingualText;
  /** Notice every surface shows: the co-branding disclaimer, or the fictitious-operator one. */
  readonly notice: BilingualText;
  /** Synthetic-demo disclaimer; only in co-branding, where it is mandatory. */
  readonly disclaimer: BilingualText | null;
  /** Keys of the partner's logos in `Seed/brand/`; `null` draws the text wordmark. */
  readonly logoAssetKeys: { readonly onLight: string; readonly onDark: string } | null;
}

/**
 * The visible brand of a `BrandConfig`. The value is validated again (it may come straight from the
 * secret's JSON in the seed loader); an invalid configuration throws instead of drawing a wrong brand.
 * The disclaimer is always this repository's text with the partner's name as its parameter, so what
 * the demo shows is the approved wording; `BrandConfig.disclaimer` is the operator's copy of it.
 */
export function resolveBrand(config: BrandConfigValue): ResolvedBrand {
  const value = BrandConfigValue.parse(config);
  if (value.mode === "neutral") {
    return {
      mode: "neutral",
      operatorName: DEFAULT_OPERATOR_NAME,
      operatorShortName: DEFAULT_OPERATOR_NAME,
      brandLine: esMX.brandLine(),
      tag: { es: esMX.fictitiousTag, en: enGloss.fictitiousTag },
      notice: { es: esMX.fictitiousOperatorNotice, en: enGloss.fictitiousOperatorNotice },
      disclaimer: null,
      logoAssetKeys: null,
    };
  }
  const disclaimer = { es: esMX.syntheticDemoNotice(value.partnerDisplayName), en: enGloss.syntheticDemoNotice(value.partnerDisplayName) };
  return {
    mode: "cobrand",
    operatorName: value.partnerDisplayName,
    operatorShortName: value.partnerShortName,
    brandLine: esMX.brandLine(value.partnerDisplayName),
    tag: { es: esMX.syntheticDemoTag, en: enGloss.syntheticDemoTag },
    notice: disclaimer,
    disclaimer,
    logoAssetKeys: { onLight: value.logoAssetKeys.onLight, onDark: value.logoAssetKeys.onDark },
  };
}

/** "<operator> (ficticia)" or "<partner> (demo sintética)": the operator's name with its tag. */
export function operatorLabel(brand: ResolvedBrand): string {
  return `${brand.operatorName} (${brand.tag.es})`;
}
