// The sign-up ticket (ADR-0025 §3): what `signup.start` hands the browser so that Cognito's `SignUp`,
// called by the browser with the password, can only create the user the server generated, for the
// email the server checked, within 10 minutes. The pre sign-up trigger verifies it.
//
//   ticket = base64url(nonce ‖ emailHash ‖ username ‖ exp) "." HMAC-SHA256(K_signup-ticket) in base64url
//
// K_signup-ticket is the HKDF subkey `signup-ticket` of `SessionTokenKey` (lib/crypto.ts). The nonce
// (a ULID) keys `Runtime/SIGNUPTICKET#<nonce>`, whose `uses` the pre sign-up raises at most to 2, always
// for the same user: a `SignUp` that failed after the trigger can be retried with the same ticket, a
// third one needs a new start.
import { z } from "zod";
import { ConnectorError } from "@cuadrilla/shared";
import { ULID_PATTERN, hmacSha256Base64Url, verifyHmacBase64Url } from "../lib/crypto";
import type { TableClient } from "../connector/table-client";
import { EmailHash, SIGNUP_USERNAME_PATTERN } from "../leads/model";

/** A ticket lives 10 minutes. */
export const SIGNUP_TICKET_TTL_MS = 10 * 60_000;
/** At most two `SignUp` for one ticket, always for its user. */
export const SIGNUP_TICKET_MAX_USES = 2;
/** `SIGNUPTICKET#` rows outlive the ticket a little (docs/architecture.md §5: 15 minutes). */
const TICKET_ROW_TTL_SECONDS = 15 * 60;
const SEPARATOR = "|";

export interface SignupTicket {
  readonly nonce: string;
  readonly emailHash: string;
  readonly username: string;
  /** Epoch seconds. */
  readonly exp: number;
}

const TicketParts = z.object({
  nonce: z.string().regex(ULID_PATTERN),
  emailHash: EmailHash,
  username: z.string().regex(SIGNUP_USERNAME_PATTERN),
  exp: z.int().positive(),
});

export function issueTicket(key: Uint8Array | string, ticket: SignupTicket): string {
  const parts = TicketParts.parse(ticket);
  const payload = Buffer.from([parts.nonce, parts.emailHash, parts.username, String(parts.exp)].join(SEPARATOR), "utf8").toString("base64url");
  return `${payload}.${hmacSha256Base64Url(key, payload)}`;
}

export type TicketCheck = { readonly ok: true; readonly ticket: SignupTicket } | { readonly ok: false; readonly reason: "MALFORMED" | "SIGNATURE" | "EXPIRED" };

/** Signature first, then the parts, then the expiry (real clock). Nothing here writes. */
export function readTicket(key: Uint8Array | string, raw: unknown, now: Date): TicketCheck {
  if (typeof raw !== "string" || raw.length > 1_024) return { ok: false, reason: "MALFORMED" };
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot !== raw.lastIndexOf(".")) return { ok: false, reason: "MALFORMED" };
  const payload = raw.slice(0, dot);
  if (!verifyHmacBase64Url(key, payload, raw.slice(dot + 1))) return { ok: false, reason: "SIGNATURE" };
  const [nonce, emailHash, username, exp, ...extra] = Buffer.from(payload, "base64url").toString("utf8").split(SEPARATOR);
  const parsed = TicketParts.safeParse({ nonce, emailHash, username, exp: Number(exp) });
  if (!parsed.success || extra.length > 0) return { ok: false, reason: "MALFORMED" };
  if (parsed.data.exp * 1000 <= now.getTime()) return { ok: false, reason: "EXPIRED" };
  return { ok: true, ticket: parsed.data };
}

export const ticketUseKey = (nonce: string) => ({ PK: `SIGNUPTICKET#${nonce}`, SK: "META" });

/**
 * Spends one use of the ticket (the pre sign-up's only write, an `UpdateItem`): `false` once it had
 * its two uses. The row names its user, fixed by the first use; the HMAC already binds the nonce to it.
 */
export async function spendTicketUse(client: Pick<TableClient, "increment">, ticket: SignupTicket, now: Date): Promise<boolean> {
  try {
    await client.increment("Runtime", ticketUseKey(ticket.nonce), "uses", 1, {
      updatedAt: now.toISOString(),
      max: SIGNUP_TICKET_MAX_USES,
      defaults: { entity: "SignupTicket", username: ticket.username, createdAt: now.toISOString(), expiresAt: Math.floor(now.getTime() / 1000) + TICKET_ROW_TTL_SECONDS },
    });
    return true;
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") return false;
    throw error;
  }
}
