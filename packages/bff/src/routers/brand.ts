// `brand` router (docs/tool-catalog.md; ADR-0018): the demo operator's visible brand for the landing,
// the sign-up, the login and the console shell. Public: it carries no data of any world, only what
// `resolveBrand` makes of the `BrandConfig` secret.
//
//   get   { mode, displayName, logos: { onLight, onDark } | null each, disclaimer: { es, en } | null }
//         Logos are presigned GETs (5 minutes) of the partner's two SVGs in `Seed/brand/`, only when the
//         object exists; otherwise `null` and the web draws the text wordmark. A logo that cannot be read
//         (a missing object answers HeadObject 403 to a role without s3:ListBucket) is `null` too: a logo
//         never fails the brand, nor the views that show it (the manual). In co-branding the
//         synthetic-demo disclaimer always travels with the partner's name.
import { resolveBrand } from "../copy/brand";
import { type ConsolePorts, consolePortsOf } from "./console-ports";
import { publicProcedure, router } from "./trpc";

/** A link is reused for most of its life; it expires after 5 minutes. */
const LOGO_LINK_REUSE_MS = 4 * 60_000;

const links = new Map<string, { readonly url: string | null; readonly untilMs: number }>();

async function logoUrl(ports: ConsolePorts, key: string, nowMs: number): Promise<string | null> {
  const cached = links.get(key);
  if (cached !== undefined && cached.untilMs > nowMs) return cached.url;
  const url = await ports.objects
    .exists("Seed", key)
    .then((exists) => (exists ? ports.objects.presignGet({ bucket: "Seed", key, contentType: "image/svg+xml" }) : null))
    .catch(() => null);
  links.set(key, { url, untilMs: nowMs + LOGO_LINK_REUSE_MS });
  return url;
}

export interface BrandView {
  readonly mode: "neutral" | "cobrand";
  readonly displayName: string;
  readonly logos: { readonly onLight: string | null; readonly onDark: string | null };
  readonly disclaimer: { readonly es: string; readonly en: string } | null;
  readonly notice: { readonly es: string; readonly en: string };
}

export async function brandView(ports: ConsolePorts): Promise<BrandView> {
  const brand = resolveBrand(ports.brand());
  const nowMs = (await ports.services.realClock.now()).getTime();
  const keys = brand.logoAssetKeys;
  const logos = keys === null ? { onLight: null, onDark: null } : { onLight: await logoUrl(ports, keys.onLight, nowMs), onDark: await logoUrl(ports, keys.onDark, nowMs) };
  return { mode: brand.mode, displayName: brand.operatorName, logos, disclaimer: brand.disclaimer, notice: brand.notice };
}

/** Test seam: forget the cached logo links. */
export function resetBrandLinks(): void {
  links.clear();
}

export const brandRouter = router({
  get: publicProcedure.query(({ ctx }) => brandView(consolePortsOf(ctx.deps))),
});
