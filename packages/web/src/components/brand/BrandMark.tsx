// The public brand line of every surface (ADR-0018, docs/design-brief.md §6):
//
//   neutral   "Cuadrilla · Powered by Craftech"
//   cobrand   "Cuadrilla for <partner> · Powered by Craftech" + the synthetic-demo disclaimer
//
// Generic on purpose: the partner's name, logos and disclaimer arrive as props from the brand
// configuration of the stage (`brand.get`, the BrandConfig secret and `Seed/brand/`), never from the
// repository. A logo is only ever drawn with <img> (an SVG from the bucket runs no script), picking
// the variant for the background (`onLight` on light, `onDark` on dark); without a logo, or while it
// fails to load, the partner's name is drawn as a text wordmark.
import { type DemoBrand, NEUTRAL_BRAND, type PartnerLogos } from "../../lib/brand";
import { BrandImage } from "./BrandImage";
import { type BrandSize, type BrandTone, CuadrillaWordmark, PoweredByCraftech, WORDMARK_TEXT } from "./Brand";

const LOGO_HEIGHT: Readonly<Record<BrandSize, string>> = { sm: "h-4", md: "h-5", lg: "h-6", xl: "h-9" };

function PartnerMark({ name, logos, tone, size }: { readonly name: string; readonly logos: PartnerLogos | undefined; readonly tone: BrandTone; readonly size: BrandSize }) {
  const text = <span className={`whitespace-nowrap font-bold tracking-tight ${WORDMARK_TEXT[size]} ${tone === "dark" ? "text-white" : "text-navy"}`}>{name}</span>;
  const src = tone === "dark" ? logos?.onDark : logos?.onLight;
  if (!src) return text;
  return <BrandImage src={src} alt={name} className={`${LOGO_HEIGHT[size]} w-auto`} fallback={text} />;
}

interface BrandMarkProps {
  readonly brand?: DemoBrand;
  readonly tone: BrandTone;
  readonly size?: BrandSize;
  /** Hides "Powered by Craftech" where the surface shows it elsewhere (the shell's footer). */
  readonly withPoweredBy?: boolean;
}

export function BrandMark({ brand = NEUTRAL_BRAND, tone, size = "md", withPoweredBy = true }: BrandMarkProps) {
  const separator = <span aria-hidden="true" className={`h-5 w-px ${tone === "dark" ? "bg-navy-soft" : "bg-mist"}`} />;
  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex flex-wrap items-center gap-x-2">
          <CuadrillaWordmark tone={tone} size={size} />
          {/* Real spaces between the parts: the line reads "Cuadrilla for <partner>" as text too. */}
          {brand.mode === "cobrand" ? (
            <>
              {" "}
              <span className={`text-sm ${tone === "dark" ? "text-mist" : "text-slate"}`}>for</span>{" "}
              <PartnerMark name={brand.partnerDisplayName} logos={brand.logos} tone={tone} size={size} />
            </>
          ) : null}
        </span>
        {withPoweredBy ? (
          <>
            {" "}
            {separator}
            <PoweredByCraftech tone={tone} />
          </>
        ) : null}
      </span>
      {brand.mode === "cobrand" ? (
        <span role="note" className={`text-xs ${tone === "dark" ? "text-mist" : "text-slate"}`}>
          {brand.disclaimer}
        </span>
      ) : null}
    </span>
  );
}
