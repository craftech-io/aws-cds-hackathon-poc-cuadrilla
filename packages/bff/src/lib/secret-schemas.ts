// Shapes of the `sst.Secret` values of infra/secrets.ts (docs/architecture.md §3, ADR-0002, ADR-0018,
// ADR-0025, ADR-0026), as pure zod schemas: packages/bff/src/lib/secrets.ts parses every value with
// them at first use, and infra/secrets.test.ts checks them without an SST link.
import { z } from "zod";
import { isCraftechMailbox } from "../leads/notify-fence";

export const SECRET_NAMES = [
  "SessionTokenKey",
  "WabaId",
  "WhatsAppPhoneNumberId",
  "WhatsAppMetaPhoneNumberId",
  "SeedOverrides",
  "BrandConfig",
  "OriginVerifyKey",
  "LeadConfig",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** Placeholder value of the three WhatsApp secrets on a stage without the live transport (docs/pending.md P-01). */
export const NOT_CONNECTED = "not-connected";

/** AWS id of the phone number: sending, media and IAM; never compared with an inbound event. */
export const WhatsAppPhoneNumberIdValue = z.union([z.literal(NOT_CONNECTED), z.string().regex(/^phone-number-id-[0-9a-f]{32}$/)]);

/** Meta id of the phone number: the only value the inbound filter compares events with. */
export const WhatsAppMetaPhoneNumberIdValue = z.union([z.literal(NOT_CONNECTED), z.string().regex(/^\d{6,20}$/)]);

export const WabaIdValue = z.union([z.literal(NOT_CONNECTED), z.string().regex(/^[A-Za-z0-9-]{6,64}$/)]);

/** Generic keys under `Seed/brand/`: never the partner's name (ADR-0018). */
const BrandAssetKey = z.string().regex(/^brand\/[a-z0-9-]+\.svg$/);

const NonEmpty = z.string().trim().min(1);

/** Brand of the worlds of the own sign-up (ADR-0018, ADR-0025 §2); `neutral` when absent. */
export const SignupBrandMode = z.enum(["neutral", "cobrand"]);
export type SignupBrandMode = z.infer<typeof SignupBrandMode>;

export const BrandConfigValue = z.discriminatedUnion("mode", [
  // Without the partner's data there is nothing to co-brand a sign-up world with.
  z.object({ mode: z.literal("neutral"), signupMode: z.literal("neutral").optional() }).strict(),
  z
    .object({
      mode: z.literal("cobrand"),
      signupMode: SignupBrandMode.optional(),
      partnerDisplayName: NonEmpty.max(60),
      partnerShortName: NonEmpty.max(30),
      logoAssetKeys: z.object({ onLight: BrandAssetKey, onDark: BrandAssetKey }).strict(),
      disclaimer: z.object({ es: NonEmpty, en: NonEmpty }).strict(),
    })
    .strict(),
]);
export type BrandConfigValue = z.infer<typeof BrandConfigValue>;

/**
 * The brand of a world of the own sign-up: `signupMode`, `neutral` by default, so a visitor's console
 * is co-branded only when the CTO says the partner's authorization covers it (ADR-0018).
 */
export function signupBrandMode(config: BrandConfigValue): SignupBrandMode {
  return config.signupMode ?? "neutral";
}

/**
 * `OriginVerifyKey` (ADR-0025 §3): 32 random bytes in base64 (`openssl rand -base64 32`, 44 characters),
 * or any value of at least 43 characters of that alphabet; never a short, guessable or placeholder value.
 */
export const OriginVerifyKeyValue = z
  .string()
  .min(43)
  .max(256)
  .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, "expected a random value in base64")
  .refine((value) => new Set(value).size >= 16, "expected a random value");

/** One mailbox of the exact domain `craftech.io`, by the strict parser of the demo's fence. */
const CraftechMailbox = z.string().refine(isCraftechMailbox, "expected a mailbox of the exact domain craftech.io");

/**
 * `LeadConfig` (ADR-0026): 1 to 5 Craftech mailboxes for the lead notice and, optionally, the privacy
 * contact the notice of privacy publishes (docs/pending.md P-06). Never written in the code.
 */
export const LeadConfigValue = z
  .object({
    notifyRecipients: z.array(CraftechMailbox).min(1).max(5),
    privacyContact: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type LeadConfigValue = z.infer<typeof LeadConfigValue>;

const Email = z.email();
const E164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

export const SeedOverridesValue = z
  .object({
    liveWorldClockId: z.string().min(1).nullable().optional(),
    demoRecipients: z.object({ emails: z.array(Email), phones: z.array(E164) }).strict().optional(),
    opsMailbox: Email.optional(),
    zoneChiefEmails: z.record(z.string(), Email).optional(),
    personPhones: z.record(z.string(), E164).optional(),
    /** Unused since P-07 (closed by the CTO on 2026-10-14: no project budget); still accepted so a loaded secret keeps parsing. */
    operatorEmail: Email.optional(),
  })
  .strict();
export type SeedOverridesValue = z.infer<typeof SeedOverridesValue>;
