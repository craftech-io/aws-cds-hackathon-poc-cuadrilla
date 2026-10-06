// What a world's staff may hold as phone and email (`upsert_person`, docs/tool-catalog.md; docs/seed-spec.md
// §2; CLAUDE.md "Identidad fuera del modelo" and "Cerco de destinatarios de email, por mundo"). Checked
// before anything is written:
//
//   GUEST worlds   only the phones of the world's own synthetic block: `+52 55 02nn 0xxx` of an invited
//                  guest (`isp-guest-<nn>`; the rehearsal `isp-guest-test` takes nn = 99) and the shared
//                  `+52 55 0300 0xxx` of the own sign-up's generations (the identity is unique per world)
//   QA, EVAL       only the leased QA block `+52 55 09xx xxxx`
//   DEMO           a synthetic phone (`+52 55 0…`), or a real phone the operator registered for the live
//                  world (`SeedOverrides.personPhones`): a real phone never enters through the console
//   every world    an email the world's recipient fence accepts (outbound/recipient-fence.ts: the SES
//                  mailbox simulator; the operator's demo recipients only in the demo world)
//
// A phone outside its block is `RECIPIENT_NOT_ALLOWED` with reason `PHONE_NOT_SYNTHETIC`; an email outside
// the fence is `RECIPIENT_NOT_ALLOWED` with the fence's reason. Neither value is ever logged or audited.
import { ToolError, guestOriginOfIsp, ispIdOfClock, ispKindOfClock, normalizePhone } from "@cuadrilla/shared";
import { isSyntheticPhone } from "../../channels/registry";
import { FENCE_RULE, type FenceReason, fenceEmailRecipient } from "../../outbound/recipient-fence";
import { markersFor } from "../../worlds/template";

export const ADDRESS_REASON = {
  PHONE_INVALID: "PHONE_INVALID",
  PHONE_NOT_SYNTHETIC: "PHONE_NOT_SYNTHETIC",
  EMAIL_INVALID: "EMAIL_INVALID",
} as const;

/** Every synthetic phone is `+52 55 <block of 4 digits> <4 digits>`. */
const COUNTRY_AREA = "+5255";
const QA_BLOCK = /^\+525509\d{6}$/;

/**
 * The phones a cloned world may register: its own block for a guest world, the QA leases for a QA or
 * evaluation world; `undefined` for the demo world, whose rule is `isSyntheticPhone` plus the live phones.
 */
export function worldPhonePattern(clockId: string): RegExp | undefined {
  const kind = ispKindOfClock(clockId);
  if (kind === "QA" || kind === "EVAL") return QA_BLOCK;
  if (kind !== "GUEST") return undefined;
  const ispId = ispIdOfClock(clockId);
  if (guestOriginOfIsp(ispId) === undefined) return undefined;
  // `02nn`, `0299` or `0300`, followed by a local number that starts with 0 (docs/seed-spec.md §2).
  return new RegExp(`^\\${COUNTRY_AREA}${markersFor(ispId).phoneBlock}0\\d{3}$`);
}

export interface AddressOptions {
  /** `SeedOverrides.personPhones` of the live world, normalized E.164 (PII: never logged). */
  readonly registeredRealPhones?: ReadonlySet<string>;
  /** `SeedOverrides.demoRecipients.emails` (PII: never logged). */
  readonly demoRecipients?: readonly string[];
}

/** The normalized phone a person of `clockId` may hold; throws `INVALID` or `RECIPIENT_NOT_ALLOWED`. */
export function checkStaffPhone(raw: string, clockId: string, options: AddressOptions = {}): string {
  let phone: string;
  try {
    phone = normalizePhone(raw);
  } catch {
    throw new ToolError("INVALID", "the phone is not a valid number", ADDRESS_REASON.PHONE_INVALID);
  }
  const pattern = worldPhonePattern(clockId);
  const allowed = pattern !== undefined ? pattern.test(phone) : isSyntheticPhone(phone) || (options.registeredRealPhones?.has(phone) ?? false);
  if (!allowed) throw new ToolError("RECIPIENT_NOT_ALLOWED", "this world only registers the synthetic phones of its own block", ADDRESS_REASON.PHONE_NOT_SYNTHETIC);
  return phone;
}

export interface CheckedEmail {
  readonly address: string;
}

/** The normalized email a person of `clockId` may hold; throws `INVALID`, or `RECIPIENT_NOT_ALLOWED` with the fence's reason. */
export function checkStaffEmail(raw: string, clockId: string, options: AddressOptions = {}): CheckedEmail {
  const decision = fenceEmailRecipient(raw, clockId, options.demoRecipients === undefined ? {} : { demoRecipients: options.demoRecipients });
  if (!decision.allowed && decision.reason === "INVALID_ADDRESS") throw new ToolError("INVALID", "the email is not a valid address", ADDRESS_REASON.EMAIL_INVALID);
  if (!decision.allowed) throw new ToolError("RECIPIENT_NOT_ALLOWED", "this world does not send email to that address", decision.reason satisfies FenceReason);
  return { address: decision.address };
}

/** The rule an email refusal names in the audit log (`DENY RECIPIENT_NOT_ALLOWED`). */
export const EMAIL_FENCE_RULES: readonly string[] = [FENCE_RULE];
