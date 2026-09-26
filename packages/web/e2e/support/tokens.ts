// The run's ephemeral RSA key (docs/test-plan.md §2, level UI): the Cognito route mock signs every id
// token with it, RS256, like the pool would. It is born with the run and dies with it: the config
// creates it in the main process (importing this module) and keeps it in the environment, so every
// worker, and any web server the config starts, signs or verifies with the same key. It is never
// written to disk and never leaves the machine.
import { type KeyObject, createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from "node:crypto";

const ENV_PRIVATE_KEY = "E2E_ID_TOKEN_PRIVATE_KEY";

function runKey(): KeyObject {
  const existing = process.env[ENV_PRIVATE_KEY];
  if (existing) return createPrivateKey(existing);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env[ENV_PRIVATE_KEY] = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return privateKey;
}

const PRIVATE_KEY = runKey();

/** `kid` of the run's key: derived from the public key, so every process names it alike. */
export const KEY_ID = `e2e-${createHash("sha256")
  .update(createPublicKey(PRIVATE_KEY).export({ type: "spki", format: "der" }))
  .digest("hex")
  .slice(0, 16)}`;

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A JWT over `claims`, RS256 with the run's key. */
export function signIdToken(claims: Readonly<Record<string, unknown>>): string {
  const signingInput = `${base64Url({ alg: "RS256", typ: "JWT", kid: KEY_ID })}.${base64Url(claims)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(PRIVATE_KEY).toString("base64url");
  return `${signingInput}.${signature}`;
}
