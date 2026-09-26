// Where a visitor came from (ADR-0026, "Formulario y consentimientos"): the five UTM tags of the first
// page of the visit and the origin of the site that sent it, captured once by app.tsx and kept only in
// this browser's `sessionStorage` until the sign-up sends them with `signup.start`. Reduced here with
// the same rules the server applies again (packages/bff/src/leads/attribution.ts): a tag out of shape
// is dropped, a referrer keeps only its scheme and host, and a referrer of this very site is no
// referrer. Nothing here is required: storage that throws (private mode) just means no attribution.
import { UTM_PARAMS, type UtmParam, referrerOriginOf, sanitizeUtm } from "@cuadrilla/bff/leads/attribution";
import { z } from "zod";

export const ATTRIBUTION_KEY = "cuadrilla.attribution";

export interface Attribution {
  readonly utm?: Partial<Record<UtmParam, string>>;
  readonly referrer?: string;
}

type AttributionStorage = Pick<Storage, "getItem" | "setItem">;

const Stored = z
  .object({
    utm: z.partialRecord(z.enum(UTM_PARAMS), z.string()).optional(),
    referrer: z.string().optional(),
  })
  .strict();

/** The attribution of a landing: the tags of `search` and the referrer's origin, if another site. */
export function attributionOf(search: string, referrer: string, ownOrigin: string): Attribution {
  const params = new URLSearchParams(search);
  const raw: Partial<Record<UtmParam, string>> = {};
  for (const param of UTM_PARAMS) {
    const value = params.get(param);
    if (value !== null) raw[param] = value;
  }
  const kept = sanitizeUtm(raw);
  const utm: Partial<Record<UtmParam, string>> = {};
  for (const [key, value] of Object.entries(kept ?? {})) if (value !== undefined) utm[`utm_${key}` as UtmParam] = value;
  const origin = referrerOriginOf(referrer);
  const external = origin !== undefined && origin !== ownOrigin.toLowerCase() ? origin : undefined;
  return { ...(Object.keys(utm).length > 0 ? { utm } : {}), ...(external === undefined ? {} : { referrer: external }) };
}

/** First visit only: a later page of the same session never replaces what the first one brought. */
export function captureAttribution(storage: AttributionStorage | undefined, search: string, referrer: string, ownOrigin: string): void {
  if (storage === undefined) return;
  try {
    if (storage.getItem(ATTRIBUTION_KEY) !== null) return;
    storage.setItem(ATTRIBUTION_KEY, JSON.stringify(attributionOf(search, referrer, ownOrigin)));
  } catch {
    // Storage unavailable: the sign-up goes on without attribution.
  }
}

export function readAttribution(storage: AttributionStorage | undefined): Attribution | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(ATTRIBUTION_KEY);
    if (raw === null) return undefined;
    const parsed = Stored.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** `sessionStorage`, or undefined where the browser refuses it. */
export function sessionStore(): AttributionStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
