// WhatsApp keywords (docs/architecture-integrations.md §4.6): resolved by code, never by the model.
// The comparison ignores case, accents and surrounding spaces or punctuation, and only a message
// made of the keyword alone counts: "dar de baja el módem" is not BAJA and "alta por favor" is not
// ALTA. Who may use each keyword (an installer, a supervisor, a live phone for a join code) is the
// channel's decision (channels/whatsapp/keywords.ts), not this parser's.
import { normalizeForMatch } from "./helpers";

export type Keyword =
  /** Opt-in of an allowlisted person (`record_consent`). */
  | { readonly kind: "ALTA" }
  /** Join code of a judge's world sent from a real phone ("ALTA J07-4F2K"). */
  | { readonly kind: "ALTA_CODE"; readonly code: string }
  /** Opt-out (`revoke_consent`). */
  | { readonly kind: "BAJA" }
  /** Plan B of a supervisor: opens the shift window (`register_shift`). */
  | { readonly kind: "TURNO" }
  /** Plan B of an installer: the day's orders without the template (`ORDERS_REQUESTED`). */
  | { readonly kind: "ORDENES" };

export type KeywordKind = Keyword["kind"];

/** The words as the staff writes them, for help texts and posters. */
export const KEYWORD_WORDS = { ALTA: "ALTA", BAJA: "BAJA", TURNO: "TURNO", ORDENES: "ÓRDENES" } as const;

const SIMPLE: Readonly<Record<string, Keyword>> = {
  alta: { kind: "ALTA" },
  baja: { kind: "BAJA" },
  turno: { kind: "TURNO" },
  ordenes: { kind: "ORDENES" },
};

// A join code is the world's prefix (2 to 5 letters or digits) and 4 characters, written with or
// without the hyphen: "J07-4F2K", "j07 4f2k" and "J074F2K" are the same code. Written together it
// needs a digit, so "alta porfavor" stays an ordinary message instead of a code "PORF-AVOR".
const JOIN_CODE = /^alta ([a-z0-9]{2,5})( ?)([a-z0-9]{4})$/;

/** The keyword the whole message is, or `null` when the message is anything else. */
export function parseKeyword(text: string): Keyword | null {
  const normalized = normalizeForMatch(text);
  const simple = SIMPLE[normalized];
  if (simple !== undefined) return simple;
  const match = JOIN_CODE.exec(normalized);
  if (match === null) return null;
  const [, prefix = "", separator = "", suffix = ""] = match;
  if (separator === "" && !/\d/.test(prefix + suffix)) return null;
  return { kind: "ALTA_CODE", code: `${prefix}-${suffix}`.toUpperCase() };
}
