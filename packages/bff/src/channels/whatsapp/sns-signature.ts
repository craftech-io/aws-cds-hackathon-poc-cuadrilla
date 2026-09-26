// Origin check of a live event (docs/architecture-integrations.md §4.4, step 1): the SNS signature,
// version 2 (SHA256withRSA) only, with a certificate that can only come from
// `https://sns.us-east-1.amazonaws.com/…pem`. The signature proves the message went through SNS, not
// which topic nor who published it: phone-filter.ts compares the signed `TopicArn` with our topic, and
// the topic policy fences the publishers (docs/architecture.md §13, residual 6).
// Certificates are downloaded with a timeout and retries, and cached per container.
import { X509Certificate, createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { withRetry } from "../../lib/retry";
import { SNS_CERT_FETCH, SNS_SIGNATURE_VERSION, SNS_SIGNING_HOST } from "./config";
import type { SnsNotification } from "./payloads";

export type SnsVerification = "VALID" | "BAD_VERSION" | "BAD_CERT_URL" | "BAD_SIGNATURE" | "UNSUPPORTED_TYPE" | "CERT_UNAVAILABLE";

export interface SnsVerifier {
  verify(sns: SnsNotification): Promise<SnsVerification>;
}

/** Lambda writes `SigningCertUrl`; SNS over HTTP writes `SigningCertURL`. */
export function signingCertUrlOf(sns: SnsNotification): string | undefined {
  return sns.SigningCertURL ?? sns.SigningCertUrl;
}

/** `https`, exactly our region's SNS host, no port or credentials, a `.pem` path. */
export function isTrustedSigningCertUrl(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === SNS_SIGNING_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.pathname.endsWith(".pem")
  );
}

/** Canonical string of a `Notification` (SNS: "Verifying the signatures of Amazon SNS messages"). */
export function snsStringToSign(sns: SnsNotification): string | undefined {
  if (sns.Type !== "Notification") return undefined;
  const fields: Array<readonly [string, string | null | undefined]> = [
    ["Message", sns.Message],
    ["MessageId", sns.MessageId],
    ["Subject", sns.Subject],
    ["Timestamp", sns.Timestamp],
    ["TopicArn", sns.TopicArn],
    ["Type", sns.Type],
  ];
  return fields
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${name}\n${String(value)}\n`)
    .join("");
}

/** Public key of a PEM certificate (what SNS serves) or of a PEM public key (tests). */
export function publicKeyOf(pem: string): KeyObject {
  return pem.includes("BEGIN CERTIFICATE") ? new X509Certificate(pem).publicKey : createPublicKey(pem);
}

export interface SnsVerifierOptions {
  /** Downloads a signing certificate (PEM); only called with a trusted URL. */
  readonly fetchCertificate: (url: string) => Promise<string>;
}

export function createSnsVerifier(options: SnsVerifierOptions): SnsVerifier {
  const keys = new Map<string, KeyObject>();

  async function keyFor(url: string): Promise<KeyObject> {
    const cached = keys.get(url);
    if (cached !== undefined) return cached;
    const key = publicKeyOf(await options.fetchCertificate(url));
    keys.set(url, key);
    return key;
  }

  return {
    async verify(sns) {
      if (sns.SignatureVersion !== SNS_SIGNATURE_VERSION) return "BAD_VERSION";
      const url = signingCertUrlOf(sns);
      if (url === undefined || !isTrustedSigningCertUrl(url)) return "BAD_CERT_URL";
      const canonical = snsStringToSign(sns);
      if (canonical === undefined) return "UNSUPPORTED_TYPE";
      let key: KeyObject;
      try {
        key = await keyFor(url);
      } catch {
        return "CERT_UNAVAILABLE";
      }
      try {
        return createVerify("RSA-SHA256").update(canonical, "utf8").verify(key, sns.Signature, "base64") ? "VALID" : "BAD_SIGNATURE";
      } catch {
        return "BAD_SIGNATURE";
      }
    },
  };
}

export interface CertificateFetcherOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Downloads a PEM with a per-attempt timeout and retries with backoff; refuses untrusted URLs. */
export function createCertificateFetcher(options: CertificateFetcherOptions = {}): (url: string) => Promise<string> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? SNS_CERT_FETCH.timeoutMs;
  return async (url) => {
    if (!isTrustedSigningCertUrl(url)) throw new Error("untrusted SNS signing certificate URL");
    return withRetry(
      async () => {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
        if (!response.ok) throw new Error(`certificate download failed with HTTP ${response.status}`);
        const pem = await response.text();
        if (!pem.includes("-----BEGIN")) throw new Error("the certificate is not PEM");
        return pem;
      },
      { attempts: options.attempts ?? SNS_CERT_FETCH.attempts, shouldRetry: () => true, ...(options.sleep === undefined ? {} : { sleep: options.sleep }) },
    );
  };
}
