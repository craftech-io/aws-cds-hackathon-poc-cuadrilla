// Button nonces (docs/architecture-integrations.md §4.6, FL-094). Every button or list row the product
// sends carries an opaque nonce as its payload; the tap brings back only the nonce, which is resolved
// against `Runtime/NONCE#<nonce>` (7 days) and must belong to the same world and the same phone. What
// the button does (its action) and on what (a case, an order, an item) are in the row, never in the
// payload, so a forged or copied payload cannot aim a button at something else. The nonce also carries
// an HMAC of its id with the `nonce` subkey: a payload we never issued is told apart from an expired one.
import { type WaButtonAction, WaButtonAction as WaButtonActionSchema } from "@cuadrilla/shared";
import type { Nonce, NonceObject } from "../../domain/runtime";
import type { AuditPort, RuntimePort } from "../../connector/ports";
import { type SecretKey, hmacSha256Base64Url, safeEqual, ulid } from "../../lib/crypto";
import type { Clock } from "../../lib/clock";

const SIGNATURE_LENGTH = 16;
const NONCE_PATTERN = /^([0-7][0-9A-HJKMNP-TV-Z]{25})_([A-Za-z0-9_-]{16})$/;

export type NonceDenial = "NONCE_FORGED" | "NONCE_EXPIRED" | "NONCE_FOREIGN" | "NONCE_ACTION";

export interface NonceDeps {
  readonly runtime: Pick<RuntimePort, "putNonce" | "getNonce" | "useNonce">;
  readonly nonceKey: SecretKey;
  /** Real time: the id of a nonce orders writes, it is not a business date. */
  readonly realClock: Clock;
}

function signatureOf(nonceKey: SecretKey, id: string): string {
  return hmacSha256Base64Url(nonceKey, `nonce\n${id}`).slice(0, SIGNATURE_LENGTH);
}

export interface IssueNonceInput {
  readonly clockId: string;
  /** Who may tap it: the person and the phone the message goes to. */
  readonly personId: string;
  readonly phoneHash: string;
  readonly action: WaButtonAction;
  readonly object: NonceObject;
  /** The outbound message that carries the button (the offer of `CONSULT_SUPERVISOR`, a case request). */
  readonly messageId?: string;
}

/** Issues one nonce and stores what it means; returns the payload to put on the button. */
export async function issueNonce(input: IssueNonceInput, deps: NonceDeps): Promise<string> {
  const id = ulid((await deps.realClock.now()).getTime());
  const nonce = `${id}_${signatureOf(deps.nonceKey, id)}`;
  await deps.runtime.putNonce({
    nonce,
    clockId: input.clockId,
    phoneHash: input.phoneHash,
    personId: input.personId,
    action: WaButtonActionSchema.parse(input.action),
    object: input.object,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
  });
  return nonce;
}

/** Whether a payload has the form and the HMAC of a nonce this app issued. */
export function isIssuedNonce(nonce: string, nonceKey: SecretKey): boolean {
  const match = NONCE_PATTERN.exec(nonce);
  if (match === null) return false;
  const [, id = "", signature = ""] = match;
  return safeEqual(signature, signatureOf(nonceKey, id));
}

export type NonceResolution = { readonly ok: true; readonly nonce: Nonce } | { readonly ok: false; readonly reason: NonceDenial };

export interface ResolveNonceInput {
  readonly payload: string;
  /** The world and the phone the tap came from. */
  readonly clockId: string;
  readonly phoneHash: string;
  /** Actions this sender may trigger (installers and supervisors have different buttons). */
  readonly allowedActions: readonly WaButtonAction[];
}

/** Resolves a tap. A nonce of another person, another world or another role's button is foreign. */
export async function resolveNonce(input: ResolveNonceInput, deps: NonceDeps): Promise<NonceResolution> {
  if (!isIssuedNonce(input.payload, deps.nonceKey)) return { ok: false, reason: "NONCE_FORGED" };
  const stored = await deps.runtime.getNonce(input.payload);
  if (stored === undefined) return { ok: false, reason: "NONCE_EXPIRED" };
  if (stored.clockId !== input.clockId || !safeEqual(stored.phoneHash, input.phoneHash)) return { ok: false, reason: "NONCE_FOREIGN" };
  if (!input.allowedActions.includes(stored.action)) return { ok: false, reason: "NONCE_ACTION" };
  return { ok: true, nonce: await deps.runtime.useNonce(input.payload) };
}

export interface NonceDenialAudit {
  readonly ispId: string;
  readonly clockId: string;
  readonly atSim: string;
  readonly personId: string;
  readonly reason: NonceDenial;
  readonly messageId: string;
}

/** `AuditLog DENY` of a refused tap (FL-094): ids only. */
export async function auditNonceDenial(audit: Pick<AuditPort, "append">, denial: NonceDenialAudit): Promise<void> {
  await audit.append({
    ispId: denial.ispId,
    clockId: denial.clockId,
    atSim: denial.atSim,
    decision: "DENY",
    action: "BUTTON_TAP",
    actor: "CHANNEL",
    reason: denial.reason,
    messageId: denial.messageId,
    refs: { personId: denial.personId },
  });
}
