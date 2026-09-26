// Shared secrets of the app (docs/architecture.md §3). Declared ONCE here; every other infra
// module imports the constant and puts it in the `link: [...]` of the Functions that need it.
// Declaring the same `sst.Secret` name in two modules is a duplicate-component error, so nobody
// writes `new sst.Secret(...)` anywhere else.
//
// | Secret                    | What it is                                                       |
// |---------------------------|------------------------------------------------------------------|
// | SessionTokenKey           | Master key. Never used directly: packages/bff/src/lib/crypto.ts  |
// |                           | derives one HKDF-SHA256 subkey per purpose (session, phone-hash, |
// |                           | email-hash, nonce, sim-envelope, runtime-session, media-key).    |
// | WabaId                    | WhatsApp Business Account id of End User Messaging Social.       |
// | WhatsAppPhoneNumberId     | AWS id of the number (`phone-number-id-<32 hex>`): sending, media |
// |                           | and the IAM ARN. Never compared with an inbound event.            |
// | WhatsAppMetaPhoneNumberId | Meta id of the number (numeric): the only value the inbound       |
// |                           | filter compares events with (ADR-0002).                          |
// | SeedOverrides             | JSON of the live world, registered demo recipients and team      |
// |                           | phones. `{}` by default. PII: never logged.                      |
// | BrandConfig               | Brand of the demo operator (ADR-0018): `{"mode":"neutral"}` or   |
// |                           | the co-branding JSON. The partner's name lives only here.        |
//
// The three WhatsApp secrets are `not-connected` until docs/pending.md P-01 is closed. The shape of
// every value is checked by packages/bff/src/lib/secret-schemas.ts (zod), which the readers and
// infra/secrets.test.ts share.
//
// How they are read: packages/bff/src/lib/secrets.ts (`secretValue(name)`), through the SST link,
// never `process.env` and never the `environment` of a Function.
//
// How they are loaded. Values are set by the operator for `poc` before the first CI deploy
// (docs/architecture.md §15 step 3); no value is ever pasted in a chat, a commit, an `.env` file or
// a CI variable. An `sst.Secret` without a value aborts the deploy, so none has a default here: a
// well-known key must fail the deploy, not ship.
//
//   npx sst secret set SessionTokenKey "$(openssl rand -base64 32)" --stage poc
//   npx sst secret set WabaId not-connected --stage poc
//   npx sst secret set WhatsAppPhoneNumberId not-connected --stage poc
//   npx sst secret set WhatsAppMetaPhoneNumberId not-connected --stage poc
//   npx sst secret set SeedOverrides '{}' --stage poc
//   npx sst secret set BrandConfig '{"mode":"neutral"}' --stage poc
//   npx sst secret list --stage poc      # prints values: never share the output
//
// - `SessionTokenKey` is never rotated casually: every phone and email hash and runtime session id
//   derives from it, so a new key means a seed reload.
// - After `sst secret set` the value reaches the Lambdas on the next deploy.

export const SessionTokenKey = new sst.Secret("SessionTokenKey");
export const WabaId = new sst.Secret("WabaId");
export const WhatsAppPhoneNumberId = new sst.Secret("WhatsAppPhoneNumberId");
export const WhatsAppMetaPhoneNumberId = new sst.Secret("WhatsAppMetaPhoneNumberId");
export const SeedOverrides = new sst.Secret("SeedOverrides");
export const BrandConfig = new sst.Secret("BrandConfig");
