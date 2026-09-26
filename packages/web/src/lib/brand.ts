// The demo operator's brand as the web draws it (ADR-0018). The stage resolves it from the
// BrandConfig secret and `Seed/brand/` and serves it through the public `brand.get` procedure; the
// repository never holds a partner's name, logo or disclaimer. Until that answer arrives, or when it
// fails or does not parse, every surface shows the neutral brand "Cuadrilla · Powered by Craftech".
import { BrandMode } from "@cuadrilla/shared";
import { z } from "zod";

/** Public procedure of the BFF (docs/tool-catalog.md, "Procedimientos de la consola"). */
export const BRAND_PROCEDURE = "brand.get";

export type BrandLanguage = "es" | "en";

export interface PartnerLogos {
  /** Presigned URL of the variant for light backgrounds. */
  readonly onLight?: string;
  /** Presigned URL of the variant for dark backgrounds. */
  readonly onDark?: string;
}

/** What BrandMark draws: the neutral line, or the co-branding with the partner and the disclaimer. */
export type DemoBrand =
  | { readonly mode: "neutral" }
  | {
      readonly mode: "cobrand";
      readonly partnerDisplayName: string;
      readonly logos?: PartnerLogos;
      /** "Demo sintética: …", already in the language of the surface. */
      readonly disclaimer: string;
    };

/** The brand every surface shows until the stage's configuration is loaded. */
export const NEUTRAL_BRAND: DemoBrand = { mode: "neutral" };

// Logos are only ever drawn with <img>; still, only an https URL (a presigned GET of the Seed
// bucket) is accepted, never a data:, blob: or javascript: one.
const LogoUrl = z
  .url()
  .refine((value) => value.startsWith("https://"), "expected an https URL")
  .nullable();

const DisplayText = z.string().trim().min(1).max(120);

/** Answer of `brand.get`. Loose: fields the BFF adds later do not break an older console. */
export const BrandView = z.looseObject({
  mode: BrandMode,
  /** Visible name of the demo operator (`resolveBrand`): the partner in co-branding, the fictitious one otherwise. */
  displayName: DisplayText,
  logos: z.looseObject({ onLight: LogoUrl, onDark: LogoUrl }).optional(),
  disclaimer: z.looseObject({ es: z.string().trim().min(1), en: z.string().trim().min(1) }).nullable().optional(),
});
export type BrandView = z.infer<typeof BrandView>;

function logosOf(view: BrandView): PartnerLogos | undefined {
  const onLight = view.logos?.onLight ?? undefined;
  const onDark = view.logos?.onDark ?? undefined;
  if (onLight === undefined && onDark === undefined) return undefined;
  return { ...(onLight !== undefined ? { onLight } : {}), ...(onDark !== undefined ? { onDark } : {}) };
}

/**
 * The brand of a surface in its language. A co-branding answer without its disclaimer falls back to
 * the neutral brand: the partner is never shown without the synthetic-demo notice (ADR-0018).
 */
export function demoBrandOf(view: BrandView | undefined, language: BrandLanguage): DemoBrand {
  if (!view || view.mode === "neutral") return NEUTRAL_BRAND;
  const disclaimer = view.disclaimer?.[language];
  if (!disclaimer) return NEUTRAL_BRAND;
  const logos = logosOf(view);
  return { mode: "cobrand", partnerDisplayName: view.displayName, disclaimer, ...(logos ? { logos } : {}) };
}
