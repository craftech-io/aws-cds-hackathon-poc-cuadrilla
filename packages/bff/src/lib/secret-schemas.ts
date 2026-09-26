// Shapes of the `sst.Secret` values of infra/secrets.ts (docs/architecture.md §3, ADR-0002, ADR-0018),
// as pure zod schemas: packages/bff/src/lib/secrets.ts parses every value with them at first use,
// and infra/secrets.test.ts checks them without an SST link.
import { z } from "zod";

export const SECRET_NAMES = [
  "SessionTokenKey",
  "WabaId",
  "WhatsAppPhoneNumberId",
  "WhatsAppMetaPhoneNumberId",
  "SeedOverrides",
  "BrandConfig",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** Value of the three WhatsApp secrets until docs/pending.md P-01 is closed. */
export const NOT_CONNECTED = "not-connected";

/** AWS id of the phone number: sending, media and IAM; never compared with an inbound event. */
export const WhatsAppPhoneNumberIdValue = z.union([z.literal(NOT_CONNECTED), z.string().regex(/^phone-number-id-[0-9a-f]{32}$/)]);

/** Meta id of the phone number: the only value the inbound filter compares events with. */
export const WhatsAppMetaPhoneNumberIdValue = z.union([z.literal(NOT_CONNECTED), z.string().regex(/^\d{6,20}$/)]);

export const WabaIdValue = z.union([z.literal(NOT_CONNECTED), z.string().regex(/^[A-Za-z0-9-]{6,64}$/)]);

/** Generic keys under `Seed/brand/`: never the partner's name (ADR-0018). */
const BrandAssetKey = z.string().regex(/^brand\/[a-z0-9-]+\.svg$/);

const NonEmpty = z.string().trim().min(1);

export const BrandConfigValue = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("neutral") }).strict(),
  z
    .object({
      mode: z.literal("cobrand"),
      partnerDisplayName: NonEmpty.max(60),
      partnerShortName: NonEmpty.max(30),
      logoAssetKeys: z.object({ onLight: BrandAssetKey, onDark: BrandAssetKey }).strict(),
      disclaimer: z.object({ es: NonEmpty, en: NonEmpty }).strict(),
    })
    .strict(),
]);
export type BrandConfigValue = z.infer<typeof BrandConfigValue>;

const Email = z.email();
const E164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

export const SeedOverridesValue = z
  .object({
    liveWorldClockId: z.string().min(1).nullable().optional(),
    demoRecipients: z.object({ emails: z.array(Email), phones: z.array(E164) }).strict().optional(),
    opsMailbox: Email.optional(),
    zoneChiefEmails: z.record(z.string(), Email).optional(),
    personPhones: z.record(z.string(), E164).optional(),
    operatorEmail: Email.optional(),
  })
  .strict();
export type SeedOverridesValue = z.infer<typeof SeedOverridesValue>;
