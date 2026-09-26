// Attribution of a lead (ADR-0026, "Formulario y consentimientos"): the five UTM tags and the origin of
// the referrer, captured by the landing in the visitor's browser and sent with the sign-up. Everything
// here is untrusted input reduced to what the lead may keep:
//
//   utm_source … utm_content   each at most 100 characters of [A-Za-z0-9._-]; any other value is
//                              DISCARDED (never truncated or repaired)
//   referrer                   only its scheme and host (`https://example.org`), and only for http(s):
//                              never its path, query, fragment or credentials
import type { Utm } from "./model";

export const UTM_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export type UtmParam = (typeof UTM_PARAMS)[number];

const UTM_VALUE = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_REFERRER_INPUT = 2_048;

/** The tags that pass, keyed without the `utm_` prefix; `undefined` when none does. */
export function sanitizeUtm(raw: Readonly<Partial<Record<UtmParam, unknown>>> | undefined): Utm | undefined {
  if (raw === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const param of UTM_PARAMS) {
    const value = raw[param];
    if (typeof value === "string" && UTM_VALUE.test(value)) out[param.slice("utm_".length)] = value;
  }
  return Object.keys(out).length === 0 ? undefined : (out as Utm);
}

/** `scheme://host[:port]` of an http(s) referrer, lower-case; `undefined` for anything else. */
export function referrerOriginOf(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REFERRER_INPUT) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hostname.length === 0) return undefined;
  return `${url.protocol}//${url.host}`.toLowerCase();
}

/** Both at once, as `signup.start` stores them. */
export function leadAttribution(raw: { readonly utm?: Readonly<Partial<Record<UtmParam, unknown>>> | undefined; readonly referrer?: unknown }): {
  readonly utm?: Utm;
  readonly referrerOrigin?: string;
} {
  const utm = sanitizeUtm(raw.utm);
  const referrerOrigin = referrerOriginOf(raw.referrer);
  return { ...(utm === undefined ? {} : { utm }), ...(referrerOrigin === undefined ? {} : { referrerOrigin }) };
}
