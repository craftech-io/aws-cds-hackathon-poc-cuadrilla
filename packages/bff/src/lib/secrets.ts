/// <reference path="../../sst-env.d.ts" />
// Linked `sst.Secret` values (infra/secrets.ts, docs/architecture.md §3), read through `Resource`
// (never `process.env`) and validated with zod (lib/secret-schemas.ts). The master `SessionTokenKey`
// never leaves this module: callers ask for the subkey of their purpose, which lib/crypto.ts derives
// with HKDF. Values are PII or key material: nothing here is ever logged, and an invalid value fails
// without echoing it.
import { Resource } from "sst";
import { z } from "zod";
import { ToolError } from "@cuadrilla/shared";
import { type SubkeyPurpose, deriveSubkey } from "./crypto";
import {
  BrandConfigValue,
  NOT_CONNECTED,
  SeedOverridesValue,
  WabaIdValue,
  WhatsAppMetaPhoneNumberIdValue,
  WhatsAppPhoneNumberIdValue,
  type SecretName,
} from "./secret-schemas";

export { SECRET_NAMES, type SecretName } from "./secret-schemas";

const SecretResource = z.object({ value: z.string().min(1) });
const cache = new Map<SecretName, string>();
const subkeys = new Map<SubkeyPurpose, Uint8Array>();

export function secretValue(name: SecretName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  let raw: unknown;
  try {
    // `Resource` is a Proxy that throws for anything not linked to this function.
    raw = Reflect.get(Resource, name);
  } catch (error) {
    throw new ToolError("UNAVAILABLE", `secret "${name}" is not linked to this function`, undefined, { cause: error });
  }
  const parsed = SecretResource.safeParse(raw);
  if (!parsed.success) throw new ToolError("UNAVAILABLE", `secret "${name}" has no value in this stage`);
  cache.set(name, parsed.data.value);
  return parsed.data.value;
}

function parsedSecret<T>(name: SecretName, schema: z.ZodType<T>, json: boolean): T {
  let raw: unknown = secretValue(name);
  if (json) {
    try {
      raw = JSON.parse(String(raw));
    } catch {
      throw new ToolError("UNAVAILABLE", `secret "${name}" is not valid JSON`);
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new ToolError("UNAVAILABLE", `secret "${name}" does not match its schema at ${paths}`);
  }
  return parsed.data;
}

// The master key is 32 random bytes in base64 (44 characters); anything shorter weakens every
// subkey derived from it, so fail loudly instead of signing.
const MIN_KEY_LENGTH = 32;

function masterKey(): string {
  const key = secretValue("SessionTokenKey");
  if (key.length < MIN_KEY_LENGTH) throw new ToolError("UNAVAILABLE", `SessionTokenKey must have at least ${MIN_KEY_LENGTH} characters`);
  return key;
}

/** The HKDF subkey of one purpose (`session`, `phone-hash`, `sim-envelope`, …), derived once per container. */
export function subkey(purpose: SubkeyPurpose): Uint8Array {
  const cached = subkeys.get(purpose);
  if (cached !== undefined) return cached;
  const derived = deriveSubkey(masterKey(), purpose);
  subkeys.set(purpose, derived);
  return derived;
}

/** Brand of the demo operator (ADR-0018); `resolveBrand` in copy/brand.ts turns it into names. */
export function brandConfig(): BrandConfigValue {
  return parsedSecret("BrandConfig", BrandConfigValue, true);
}

/** Live world, registered demo recipients and team phones. PII: never logged. */
export function seedOverrides(): SeedOverridesValue {
  return parsedSecret("SeedOverrides", SeedOverridesValue, true);
}

/**
 * The two ids of the WhatsApp number and the WABA (ADR-0002): the AWS id sends, fetches media and
 * builds the IAM ARN; the Meta id is the only value an inbound event is compared with. `undefined`
 * while any of them still says `not-connected` (docs/pending.md P-01).
 */
export interface WhatsAppConnection {
  readonly wabaId: string;
  readonly phoneNumberId: string;
  readonly metaPhoneNumberId: string;
}

export function whatsAppConnection(): WhatsAppConnection | undefined {
  const wabaId = parsedSecret("WabaId", WabaIdValue, false);
  const phoneNumberId = parsedSecret("WhatsAppPhoneNumberId", WhatsAppPhoneNumberIdValue, false);
  const metaPhoneNumberId = parsedSecret("WhatsAppMetaPhoneNumberId", WhatsAppMetaPhoneNumberIdValue, false);
  if (wabaId === NOT_CONNECTED || phoneNumberId === NOT_CONNECTED || metaPhoneNumberId === NOT_CONNECTED) return undefined;
  return { wabaId, phoneNumberId, metaPhoneNumberId };
}

/** Test seam. */
export function resetSecretCache(): void {
  cache.clear();
  subkeys.clear();
}
