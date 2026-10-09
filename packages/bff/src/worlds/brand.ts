// The visible name of every world's operator (ADR-0018, docs/seed-spec.md §4): `Isps/META.displayName`
// is always `resolveBrand(BrandConfig)` (a sign-up generation follows `signupMode`, neutral by default),
// never a literal of the seed. When `BrandConfig` changes, `seed:load` rewrites the name of every
// existing world and renders its historical certificates again with the new brand, without resetting it.
import { createHash } from "node:crypto";
import { guestOriginOfIsp, parseClockId } from "@cuadrilla/shared";
import { resolveBrand } from "../copy/brand";
import type { Connector } from "../connector/ports";
import type { BrandConfigValue } from "../lib/secret-schemas";
import type { HistoricalCertificates, WorldRef } from "./certificates";
import { displayNameFor } from "./factory";

/** The operator's visible name in the world of `clockId`. */
export function worldDisplayName(config: BrandConfigValue, clockId: string): string {
  const parsed = parseClockId(clockId);
  const origin = parsed?.kind === "GUEST" ? guestOriginOfIsp(parsed.ispId) : undefined;
  return origin === undefined ? resolveBrand(config).operatorName : displayNameFor(config, origin);
}

/** A digest of the brand configuration: `seed:load` rewrites the worlds when it changes. */
export function brandFingerprint(config: BrandConfigValue): string {
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

/** JSON with the keys of every object in order: the same value always gives the same text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface BrandRewrite extends WorldRef {
  readonly renamed: boolean;
  readonly certificates: number;
}

export interface BrandDeps {
  readonly connector: Pick<Connector, "isps">;
  readonly brand: () => BrandConfigValue;
  readonly certificates?: HistoricalCertificates;
}

/**
 * Rewrites the visible name of each world whose name is not its brand's, and renders all of its
 * certificates again (`force` renders them even when the name did not change). Nothing else of the
 * world changes: no reset, no new epoch.
 */
export async function rewriteBrand(deps: BrandDeps, worlds: readonly WorldRef[], options: { readonly force?: boolean } = {}): Promise<BrandRewrite[]> {
  const config = deps.brand();
  const out: BrandRewrite[] = [];
  for (const world of worlds) {
    const isp = await deps.connector.isps.getIsp(world.ispId);
    if (isp === undefined) continue;
    const name = worldDisplayName(config, world.clockId);
    const renamed = isp.displayName !== name;
    if (renamed) await deps.connector.isps.setDisplayName(world.ispId, name);
    const certificates = (renamed || options.force === true) && deps.certificates !== undefined ? await deps.certificates.render(world, "ALL") : 0;
    out.push({ ...world, renamed, certificates });
  }
  return out;
}
