// Test-only Cognito stand-in: a throwaway RSA key pair, the JWKS a pool would publish for it and
// a signer for id tokens. Nothing here ships in a Lambda bundle (only *.test.ts imports it).
import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import type { Fetcher } from "aws-jwt-verify/https";
import { type IdTokenVerifier, createCognitoIdTokenVerifier } from "./jwt";

export const TEST_POOL = { userPoolId: "us-east-1_TESTPOOL1", clientId: "test-web-client", region: "us-east-1" } as const;
export const TEST_ISSUER = `https://cognito-idp.${TEST_POOL.region}.amazonaws.com/${TEST_POOL.userPoolId}`;

export type TestClaims = Record<string, unknown>;

export interface TestIssuer {
  readonly kid: string;
  readonly jwks: { keys: Record<string, unknown>[] };
  /** Serves `jwks`; counts the requests so tests can assert the cache. */
  readonly fetcher: Fetcher & { requests: number };
  /** Signs an id token; `overrides` replace or (with `undefined`) remove default claims. */
  idToken(overrides?: TestClaims, header?: Record<string, unknown>): string;
  verifier(): IdTokenVerifier;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(header: Record<string, unknown>, payload: TestClaims, privateKey: KeyObject): string {
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function createTestIssuer(options: { kid?: string; now?: () => Date } = {}): TestIssuer {
  const kid = options.kid ?? "test-key-1";
  const now = options.now ?? (() => new Date());
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] };

  const fetcher: TestIssuer["fetcher"] = {
    requests: 0,
    async fetch() {
      fetcher.requests += 1;
      const bytes = new TextEncoder().encode(JSON.stringify(jwks));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };

  return {
    kid,
    jwks,
    fetcher,
    idToken(overrides = {}, header = {}) {
      const issuedAt = Math.floor(now().getTime() / 1000);
      const payload: TestClaims = {
        sub: "7f1c9d2e-0000-4000-8000-000000000001",
        iss: TEST_ISSUER,
        aud: TEST_POOL.clientId,
        token_use: "id",
        auth_time: issuedAt,
        iat: issuedAt,
        exp: issuedAt + 3600,
        "cognito:username": "7f1c9d2e-0000-4000-8000-000000000001",
        "cognito:groups": ["SUPERVISOR"],
        ispId: "isp-demo",
        userId: "usr-sup-01",
        role: "SUPERVISOR",
        email: "supervisor@example.test",
        ...overrides,
      };
      for (const [claim, value] of Object.entries(payload)) if (value === undefined) delete payload[claim];
      return signJwt({ alg: "RS256", typ: "JWT", kid, ...header }, payload, privateKey);
    },
    verifier: () => createCognitoIdTokenVerifier(TEST_POOL, { fetcher }),
  };
}
