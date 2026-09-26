// Brand of the product: the "Cuadrilla" wordmark (text, no logo file) and a discreet "Powered by
// Craftech" with Craftech's logo. Craftech's logo files live in public/brand/ (light backgrounds:
// color SVG; dark: white SVG); every mark falls back to text. The demo operator's brand (co-branding
// with the design partner, or the neutral fallback) is runtime configuration drawn by BrandMark.tsx
// (ADR-0018); no other brand is ever committed.
import { BrandImage } from "./BrandImage";

export type BrandTone = "light" | "dark";

export const BRAND_ASSETS = {
  craftech: { light: "/brand/logo-craftech-color.svg", dark: "/brand/logo-craftech-blanco.svg" },
} as const;

export const CRAFTECH_URL = "https://craftech.io";

export type BrandSize = "sm" | "md" | "lg" | "xl";

export const WORDMARK_TEXT: Readonly<Record<BrandSize, string>> = { sm: "text-sm", md: "text-base", lg: "text-lg", xl: "text-3xl" };

/** The product: "Cuadrilla". */
export function CuadrillaWordmark({ tone, size = "md" }: { readonly tone: BrandTone; readonly size?: BrandSize }) {
  return (
    <span className={`whitespace-nowrap font-bold tracking-tight ${WORDMARK_TEXT[size]} ${tone === "dark" ? "text-white" : "text-navy"}`}>
      Cuadrilla<span className={tone === "dark" ? "text-cyan" : "text-cyan-deep"}>.</span>
    </span>
  );
}

/** "Powered by" + the Craftech logo, linking to craftech.io. */
export function PoweredByCraftech({ tone, className = "" }: { readonly tone: BrandTone; readonly className?: string }) {
  const fallback = <span className={`font-bold ${tone === "dark" ? "text-white" : "text-craftech"}`}>Craftech</span>;
  return (
    <a
      href={CRAFTECH_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-2 text-xs transition-opacity hover:opacity-80 ${tone === "dark" ? "text-mist" : "text-slate"} ${className}`}
    >
      <span>Powered by</span>
      <BrandImage src={BRAND_ASSETS.craftech[tone]} alt="Craftech" className="h-5 w-auto" fallback={fallback} />
    </a>
  );
}
