// The BFF Lambda verifies id tokens offline against the keys of its linked user pool, and nothing a
// request, a token or the deployed handler carries can make it trust other keys (docs/test-plan.md
// §2, "UI" level: the ephemeral JWKS of the local UI server is injected only from that server's own
// entry). The Lambda's `Resource` and the JWKS download are the two seams replaced here.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectorError } from "@cuadrilla/shared";
import { FetchError } from "aws-jwt-verify/error";
import { fetch as jwksFetch } from "aws-jwt-verify/https";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetResourceCache } from "../lib/resource";
import { resetSecretCache } from "../lib/secrets";
import { defaultDeps, resetDefaultDeps } from "../routers/deps";
import { ORIGIN_HEADER } from "../routers/edge";
import { handler } from "../routers/handler";
import { INTERNAL_ERROR_MESSAGE, createContext } from "../routers/trpc";
import { AUTH_REASON } from "./errors";
import { staticJwksFetcher } from "./jwt";
import { TEST_ISSUER, TEST_JWKS_URI, TEST_POOL, createTestIssuer, functionUrlEvent, testLambdaContext, trpcResponse } from "./testing";

// What SST links into the function. The stand-in throws for anything not linked, like SST's own.
const links = vi.hoisted(() => new Map<string, unknown>());
vi.mock("sst", () => ({
  Resource: new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string") return undefined;
        if (links.has(name)) return links.get(name);
        throw new Error(`${name} is not linked to this function`);
      },
    },
  ),
}));

// Every JWKS download of the Lambda goes through this function (auth/jwt.ts, BackoffFetcher).
vi.mock("aws-jwt-verify/https", async (importOriginal) => ({ ...(await importOriginal<typeof import("aws-jwt-verify/https")>()), fetch: vi.fn() }));

const AUTH_LINK = { userPoolId: TEST_POOL.userPoolId, clientId: TEST_POOL.clientId, issuerUrl: TEST_ISSUER, region: TEST_POOL.region };
const ATTACKER_JWKS = "https://keys.attacker.test/.well-known/jwks.json";
/** The deployed handler answers only what came through CloudFront (ADR-0025 §3): a test origin key. */
const ORIGIN_KEY = "Pw7Dn2Rk9Tz4Lm1Qv8Xc3Hb6Js0Fy5Ga+Ne/Ku7Wd2E=";
const pool = createTestIssuer();

let requested: string[];
let written: string[];

function link(auth: unknown): void {
  links.clear();
  links.set("OriginVerifyKey", { value: ORIGIN_KEY });
  if (auth !== undefined) links.set("Auth", auth);
  resetResourceCache();
  resetSecretCache();
  resetDefaultDeps();
}

const contextFor = (token: string) => createContext({ event: { headers: { authorization: `Bearer ${token}` } } });
const throughEdge = (headers: Record<string, string>) => ({ ...headers, [ORIGIN_HEADER]: ORIGIN_KEY });
const ping = async (headers: Record<string, string>) => trpcResponse(await handler(functionUrlEvent("/api/health.ping", { headers: throughEdge(headers) }), testLambdaContext));

beforeEach(() => {
  requested = [];
  written = [];
  link(AUTH_LINK);
  const served = staticJwksFetcher(pool.jwks);
  vi.mocked(jwksFetch).mockImplementation((uri, options, data) => {
    requested.push(uri);
    return uri === TEST_JWKS_URI ? served.fetch(uri, options, data) : Promise.reject(new FetchError(uri, "not the pool's JWKS"));
  });
  // The deployed handler logs to stdout; the lines are kept for the assertions instead.
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  link(undefined);
});

describe("the BFF Lambda trusts only the keys of its linked pool [FL-079]", () => {
  it("[FL-079] verifies a token of the linked pool offline, fetching keys only from <issuer>/.well-known/jwks.json", async () => {
    const context = await contextFor(pool.idToken());
    expect(context.authFailure).toBeNull();
    expect(context.principal).toMatchObject({ origin: "COGNITO", ispId: "isp-demo", userId: "usr-sup-01", role: "SUPERVISOR" });
    expect((await contextFor(pool.idToken({ sub: "7f1c9d2e-0000-4000-8000-000000000002" }))).principal?.sub).toBe("7f1c9d2e-0000-4000-8000-000000000002");
    expect(requested).toEqual([TEST_JWKS_URI]);
  });

  it("[FL-079] follows no key a token names: jku, x5u, an embedded jwk, another pool's issuer, another key under the pool's kid", async () => {
    const attacker = createTestIssuer({ kid: "attacker-key" });
    const forged = [
      attacker.idToken({}, { jku: ATTACKER_JWKS }),
      attacker.idToken({}, { x5u: "https://keys.attacker.test/signing.pem" }),
      attacker.idToken({}, { jwk: attacker.jwks.keys[0] }),
      attacker.idToken({ iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ATTACKER1" }),
      createTestIssuer({ kid: pool.kid }).idToken({}, { jku: ATTACKER_JWKS }),
    ];
    for (const token of forged) {
      const context = await contextFor(token);
      expect(context.principal).toBeNull();
      expect(context.authFailure?.reason).toBe(AUTH_REASON.TOKEN_INVALID);
    }
    expect(new Set(requested)).toEqual(new Set([TEST_JWKS_URI]));
  });

  it("[FL-079] the deployed handler refuses a forged token whatever the request headers say, and logs no token", async () => {
    const attacker = createTestIssuer({ kid: "attacker-key" });
    const token = attacker.idToken({}, { jku: ATTACKER_JWKS });
    const headers = { authorization: `Bearer ${token}`, "x-jwks-uri": ATTACKER_JWKS, "x-jwks": JSON.stringify(attacker.jwks), "x-cognito-issuer": "https://keys.attacker.test" };
    const refused = await ping(headers);
    expect(refused.status).toBe(401);
    expect(refused.body.error?.data).toMatchObject({ code: "UNAUTHORIZED", reason: AUTH_REASON.TOKEN_INVALID });
    expect(requested.every((uri) => uri === TEST_JWKS_URI)).toBe(true);
    // Only the principal was refused: the public probe of the same handler answers.
    expect(trpcResponse(await handler(functionUrlEvent("/api/health", { headers: throughEdge(headers) }), testLambdaContext)).status).toBe(200);
    const log = written.join("");
    expect(log).toContain("console.auth.refused");
    expect(log).not.toContain(token);
    expect(log).not.toContain(token.split(".")[1] ?? token);
  });

  it("[FL-079] builds the Lambda's dependencies once, from the link alone, and freezes them", () => {
    const deps = defaultDeps();
    expect(Object.isFrozen(deps)).toBe(true);
    expect(defaultDeps()).toBe(deps);
    expect(Reflect.set(deps, "verifier", pool.verifier())).toBe(false);
    expect(() => Object.assign(deps, { verifier: pool.verifier() })).toThrow(TypeError);
  });

  it("[FL-079] fails closed when the link names another issuer or region, or no pool is linked", async () => {
    const misconfigured = [
      { ...AUTH_LINK, issuerUrl: "https://keys.attacker.test" },
      { ...AUTH_LINK, issuerUrl: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ATTACKER1" },
      { ...AUTH_LINK, region: "us-west-2" },
      { ...AUTH_LINK, userPoolId: "attacker" },
      undefined,
    ];
    for (const auth of misconfigured) {
      link(auth);
      expect(() => defaultDeps()).toThrowError(ConnectorError);
      const response = await ping({ authorization: `Bearer ${pool.idToken()}` });
      expect(response.status).toBe(500);
      expect(response.body.error?.message).toBe(INTERNAL_ERROR_MESSAGE);
    }
    expect(requested).toEqual([]);
  });
});

// ---- The source itself: no Lambda module can build a verifier that trusts other keys. ----

const SRC = fileURLToPath(new URL("..", import.meta.url));
const TEST_SUPPORT = /(\.test\.tsx?$|(^|\/)(testing|__tests__|fixtures)(\/|\.ts$))/;

function lambdaSources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return lambdaSources(path);
    const file = relative(SRC, path).split(sep).join("/");
    return file.endsWith(".ts") && !TEST_SUPPORT.test(file) ? [file] : [];
  });
}

interface SourceFacts {
  /** Argument count of each `createCognitoIdTokenVerifier(...)` call. */
  readonly verifierCalls: number[];
  readonly namesStaticJwks: boolean;
  readonly importsVerifierLibrary: boolean;
  readonly readsEnvironment: boolean;
}

function factsOf(file: string): SourceFacts {
  const source = ts.createSourceFile(file, readFileSync(join(SRC, file), "utf8"), ts.ScriptTarget.Latest, true);
  const facts = { verifierCalls: [] as number[], namesStaticJwks: false, importsVerifierLibrary: false, readsEnvironment: false };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createCognitoIdTokenVerifier") facts.verifierCalls.push(node.arguments.length);
    if (ts.isIdentifier(node) && node.text === "staticJwksFetcher") facts.namesStaticJwks = true;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("aws-jwt-verify")) facts.importsVerifierLibrary = true;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "env") facts.readsEnvironment = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}

describe("no Lambda module can inject a JWKS [FL-079]", () => {
  const facts = new Map(lambdaSources().map((file) => [file, factsOf(file)]));
  const filesWhere = (predicate: (fact: SourceFacts) => boolean) => [...facts].filter(([, fact]) => predicate(fact)).map(([file]) => file);

  it("[FL-079] builds verifiers only from the pool id and client id: no call passes a JWKS fetcher", () => {
    const calls = [...facts].flatMap(([file, fact]) => fact.verifierCalls.map((args) => ({ file, args })));
    expect(calls).toContainEqual({ file: "routers/deps.ts", args: 1 });
    expect(calls.filter((call) => call.args !== 1)).toEqual([]);
  });

  it("[FL-079] keeps the verifier library and the in-memory JWKS inside auth/jwt.ts", () => {
    expect(filesWhere((fact) => fact.importsVerifierLibrary)).toEqual(["auth/jwt.ts"]);
    expect(filesWhere((fact) => fact.namesStaticJwks)).toEqual(["auth/jwt.ts"]);
  });

  it("[FL-079] reads nothing from the environment on the way from the request to the verifier", () => {
    for (const file of ["auth/config.ts", "auth/jwt.ts", "auth/principal.ts", "routers/deps.ts", "routers/trpc.ts", "routers/handler.ts"]) {
      expect(facts.get(file), file).toMatchObject({ readsEnvironment: false });
    }
  });
});
