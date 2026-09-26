/// <reference path="../../sst-env.d.ts" />
// The edge of the console BFF (ADR-0025 §3): what every request to `/api/*` passes before tRPC reads
// a byte of it. Two checks, in this order:
//
//   1. Origin. The Router adds `x-cuadrilla-origin: <OriginVerifyKey>` on the origin of `/api/*`
//      (infra/bff.ts, infra/web.ts); a request without it, or with another value, did not come
//      through CloudFront (a call on the Function URL, which skips the WAF and could forge the viewer
//      address). The header is compared in constant time (`timingSafeEqual` over the SHA-256 of both
//      values) and a refusal is `403` without a body, before anything is parsed: metric
//      `OriginRejected`, never the value in a log. The header then leaves the event. Only after this
//      check is `CloudFront-Viewer-Address` read (the viewer IP of the sign-up limits), together with
//      the header AWS WAF inserts for an anonymous IP (`x-amzn-waf-cuadrilla-anon`).
//   2. The one shape of the sign-up. The web calls `signup.start` alone (`httpLink`), and the WAF
//      scope of the sign-up matches any request that names `signup.`; tRPC, though, would run a
//      procedure inside a batch or under an encoded path. So a request whose path, decoded until it
//      stops changing and lower-cased, names a `signup.` procedure (in a batch list or anywhere in
//      the path) passes only as `POST` to exactly `/api/signup.start` without a `batch` parameter;
//      anything else is `400` without a body (metric `EdgeRejected{reason=SIGNUP_SHAPE}`, never the
//      path or the body in a log), so no counter, lead or ticket is written. Batches of the other
//      procedures go on as before.
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { OriginVerifyKeyValue } from "../lib/secret-schemas";
import { secretValue } from "../lib/secrets";
import { type Logger, createLogger } from "../lib/log";
import { describeError } from "../auth/errors";
import type { EdgeContext } from "./trpc";

/** Header the Router adds on the origin of `/api/*` (a viewer's header of the same name is replaced). */
export const ORIGIN_HEADER = "x-cuadrilla-origin";
/** `ip:port` of the viewer, set by CloudFront (IPv6 without brackets: the port is after the last colon). */
export const VIEWER_ADDRESS_HEADER = "cloudfront-viewer-address";
/** Inserted by the `AnonymousIpSignup` rule of the edge web ACL (`cuadrilla-anon`, prefixed by AWS WAF). */
export const ANONYMOUS_IP_HEADER = "x-amzn-waf-cuadrilla-anon";

/** The only form in which a `signup.` procedure is served. */
export const SIGNUP_START_PATH = "/api/signup.start";
const SIGNUP_PROCEDURE = "signup.";
const API_PREFIX = "/api/";
const MAX_DECODE_ROUNDS = 8;

export type EdgeRejection = "ORIGIN" | "SIGNUP_SHAPE" | "ORIGIN_KEY_UNAVAILABLE";

export type EdgeVerdict =
  | { readonly kind: "PASS"; readonly event: APIGatewayProxyEventV2; readonly edge: EdgeContext | undefined }
  | { readonly kind: "REJECT"; readonly reason: EdgeRejection; readonly response: APIGatewayProxyStructuredResultV2 };

export interface EdgeGuardDeps {
  /** The `OriginVerifyKey` value (a secret: never logged). */
  readonly originKey: () => string;
  readonly log: () => Logger;
}

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Constant time over two SHA-256 digests: the time never depends on how much of the value matched. */
export function originMatches(given: string | undefined, expected: string): boolean {
  const left = digest(given ?? "");
  const right = digest(expected);
  return timingSafeEqual(left, right) && given !== undefined && given.length > 0;
}

/** `203.0.113.10:46532` → `203.0.113.10`; `2001:db8::1:46532` → `2001:db8::1`; anything else → undefined. */
export function viewerIpOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0 || !/^\d{1,5}$/.test(trimmed.slice(colon + 1))) return undefined;
  const ip = trimmed.slice(0, colon).replace(/^\[(.*)\]$/, "$1");
  return isIP(ip) === 0 ? undefined : ip;
}

/** The path as tRPC will read it: percent-decoded until it stops changing, lower-cased. */
export function decodedPath(rawPath: string): string {
  let current = rawPath;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    current = next;
  }
  return current.toLowerCase();
}

/** Whether the request names a `signup.` procedure, in a batch list, encoded or anywhere in its path. */
export function namesSignupProcedure(rawPath: string): boolean {
  const path = decodedPath(rawPath);
  if (path.includes(SIGNUP_PROCEDURE)) return true;
  const procedures = (path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) : path.replace(/^\//, "")).split(",");
  return procedures.some((procedure) => procedure.trim().startsWith(SIGNUP_PROCEDURE));
}

function hasBatchParameter(rawQueryString: string | undefined): boolean {
  if (!rawQueryString) return false;
  const params = new URLSearchParams(rawQueryString);
  return [...params.keys()].some((key) => decodedPath(key) === "batch");
}

/** The one shape: `POST`, `rawPath` exactly `/api/signup.start` (no encoding, no trailing slash, no comma), no `batch`. */
export function isSignupShape(event: Pick<APIGatewayProxyEventV2, "rawPath" | "rawQueryString" | "requestContext">): boolean {
  return event.rawPath === SIGNUP_START_PATH && event.requestContext.http.method.toUpperCase() === "POST" && !hasBatchParameter(event.rawQueryString);
}

const empty = (statusCode: number): APIGatewayProxyStructuredResultV2 => ({ statusCode, headers: { "cache-control": "no-store" }, body: "" });

function reject(reason: EdgeRejection, statusCode: number): EdgeVerdict {
  return { kind: "REJECT", reason, response: empty(statusCode) };
}

// Function URL headers arrive lower-cased: each one is read by its exact name, so a refused request
// never touches another header (the viewer address above all).
function headerOf(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const headers = event.headers ?? {};
  return Object.hasOwn(headers, name) ? headers[name] : undefined;
}

function withoutOriginHeader(event: APIGatewayProxyEventV2): APIGatewayProxyEventV2 {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) if (name.toLowerCase() !== ORIGIN_HEADER) headers[name] = value;
  return { ...event, headers };
}

/** Runs both checks. A `PASS` hands back the event without the origin header and the viewer, if CloudFront named one. */
export function guardEdge(event: APIGatewayProxyEventV2, deps: EdgeGuardDeps): EdgeVerdict {
  let expected: string;
  try {
    expected = OriginVerifyKeyValue.parse(deps.originKey());
  } catch (error) {
    // Nothing can be told apart without the key: fail closed, and say so to the operator.
    deps.log().error("edge.origin_key.unavailable", { metric: "OriginKeyUnavailable", value: 1, ...describeError(error) });
    return reject("ORIGIN_KEY_UNAVAILABLE", 503);
  }
  if (!originMatches(headerOf(event, ORIGIN_HEADER), expected)) {
    deps.log().warn("edge.origin.rejected", { metric: "OriginRejected", value: 1 });
    return reject("ORIGIN", 403);
  }
  if (namesSignupProcedure(event.rawPath) && !isSignupShape(event)) {
    deps.log().warn("edge.signup_shape.rejected", { metric: "EdgeRejected", reason: "SIGNUP_SHAPE", value: 1 });
    return reject("SIGNUP_SHAPE", 400);
  }
  const passed = withoutOriginHeader(event);
  const viewerIp = viewerIpOf(headerOf(passed, VIEWER_ADDRESS_HEADER));
  const edge: EdgeContext | undefined = viewerIp === undefined ? undefined : { viewerIp, ...(headerOf(passed, ANONYMOUS_IP_HEADER) === undefined ? {} : { anonymousIp: true }) };
  return { kind: "PASS", event: passed, edge };
}

/** The deployed BFF's guard: `OriginVerifyKey` through its link (`Resource`, never `process.env`). */
export function linkedEdgeGuard(): EdgeGuardDeps {
  return {
    originKey: () => secretValue("OriginVerifyKey"),
    log: () => createLogger({ bindings: { service: "bff", component: "edge" } }),
  };
}
