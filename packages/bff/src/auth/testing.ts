// Test-only Cognito stand-in: a throwaway RSA key pair, the JWKS a pool would publish for it and
// a signer for id tokens, plus the console's dependencies over an in-memory connector and the
// Function URL events the BFF handler receives. Nothing here ships in a Lambda bundle (only
// *.test.ts imports it).
import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context as LambdaContext } from "aws-lambda";
import type { Fetcher } from "aws-jwt-verify/https";
import { z } from "zod";
import { createMemoryConnector } from "../connector/index";
import type { Connector } from "../connector/ports";
import { createLogger } from "../lib/log";
import type { ContextDeps } from "../routers/deps";
import { memorySignupPorts } from "../signup/testing";
import { cognitoIssuer } from "./config";
import { type IdTokenVerifier, createCognitoIdTokenVerifier, staticJwksFetcher } from "./jwt";
import { createUserDirectory } from "./staff";

export const TEST_POOL = { userPoolId: "us-east-1_TESTPOOL1", clientId: "test-web-client", region: "us-east-1" } as const;
export const TEST_ISSUER = cognitoIssuer(TEST_POOL.userPoolId);
/** Where aws-jwt-verify fetches the pool's keys from: the only JWKS the Lambda ever reads. */
export const TEST_JWKS_URI = `${TEST_ISSUER}/.well-known/jwks.json`;

/** Validity of the pool's id tokens. */
export const TOKEN_LIFETIME_SECONDS = 15 * 60;

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
  const served = staticJwksFetcher(jwks);

  const fetcher: TestIssuer["fetcher"] = {
    requests: 0,
    fetch(uri, requestOptions, data) {
      fetcher.requests += 1;
      return served.fetch(uri, requestOptions, data);
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
        // The pool's id tokens live 15 minutes (infra/auth-email.ts, WEB_CLIENT_SETTINGS).
        exp: issuedAt + TOKEN_LIFETIME_SECONDS,
        origin_jti: "0b6f3c1e-0000-4000-8000-00000000a001",
        "cognito:username": "7f1c9d2e-0000-4000-8000-000000000001",
        "cognito:groups": ["SUPERVISOR"],
        ispId: "isp-demo",
        userId: "usr-sup-01",
        role: "SUPERVISOR",
        isGuest: "false",
        email: "supervisor@example.test",
        ...overrides,
      };
      for (const [claim, value] of Object.entries(payload)) if (value === undefined) delete payload[claim];
      return signJwt({ alg: "RS256", typ: "JWT", kid, ...header }, payload, privateKey);
    },
    verifier: () => createCognitoIdTokenVerifier(TEST_POOL, { fetcher }),
  };
}

export interface TestContextDeps extends ContextDeps {
  /** Every JSON line the request loggers wrote. */
  readonly lines: string[];
}

/**
 * The console's dependencies for a router test: the issuer's verifier, an in-memory connector (or
 * the one given), its user directory, healthy mocks and the sign-up's ports over memory (nothing
 * reaches the network); `overrides` replace any of them.
 */
export function testContextDeps(issuer: TestIssuer, overrides: Partial<ContextDeps> & { readonly connector?: Connector } = {}): TestContextDeps {
  const lines: string[] = [];
  const connector = overrides.connector ?? createMemoryConnector().connector;
  const signup = memorySignupPorts(overrides.wallClock);
  return {
    lines,
    verifier: issuer.verifier(),
    connector,
    users: createUserDirectory(connector.isps),
    mocks: () => Promise.resolve({ network: "OK", dispatch: "OK" }),
    wallClock: () => new Date(),
    loggerFor: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => void lines.push(line) }),
    signup: () => signup,
    ...overrides,
  };
}

export interface TestRequest {
  readonly method?: "GET" | "POST";
  readonly headers?: Record<string, string>;
  /** Raw query string, e.g. `input=%7B%7D`. */
  readonly query?: string;
  readonly body?: string;
  /** Function URL request id: the correlation id when the console sends none. */
  readonly requestId?: string;
}

/** A Function URL event (payload format 2.0), as the Router forwards `/api/*` to the BFF. */
export function functionUrlEvent(rawPath: string, request: TestRequest = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: request.query ?? "",
    headers: request.headers ?? {},
    isBase64Encoded: false,
    ...(request.body === undefined ? {} : { body: request.body }),
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "bff-url.lambda-url.us-east-1.on.aws",
      domainPrefix: "bff-url",
      http: { method: request.method ?? "GET", path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "vitest" },
      requestId: request.requestId ?? "req-test-0001",
      routeKey: "$default",
      stage: "$default",
      time: "13/Oct/2026:15:20:00 +0000",
      timeEpoch: 1791904800000,
    },
  };
}

export const testLambdaContext: LambdaContext = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "bff-test",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:bff-test",
  memoryLimitInMB: "512",
  awsRequestId: "lambda-req-0001",
  logGroupName: "/aws/lambda/bff-test",
  logStreamName: "2026/10/13/[$LATEST]test",
  getRemainingTimeInMillis: () => 10_000,
  done: () => undefined,
  fail: () => undefined,
  succeed: () => undefined,
};

const TrpcBody = z.looseObject({
  result: z.object({ data: z.unknown() }).optional(),
  error: z
    .looseObject({
      message: z.string(),
      data: z.looseObject({ code: z.string(), httpStatus: z.number().optional(), reason: z.string().nullable(), correlationId: z.string().nullable() }),
    })
    .optional(),
});
export type TrpcBody = z.infer<typeof TrpcBody>;

/** Status, headers and the parsed tRPC body of a handler response. */
export function trpcResponse(response: APIGatewayProxyStructuredResultV2): { status: number | undefined; headers: Record<string, unknown>; body: TrpcBody } {
  return { status: response.statusCode, headers: response.headers ?? {}, body: TrpcBody.parse(JSON.parse(response.body ?? "{}")) };
}
