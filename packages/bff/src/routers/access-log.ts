// The access line of the console BFF (ADR-0030): one JSON line per HTTP request of its Function URL,
// written when the request ends, also for the ones refused before tRPC (origin, the sign-up's shape)
// and when the handler fails (500). So an incident can be read back request by request:
//
//   {"message":"access","route","method","status","ip","userAgent","sub","ms", "correlationId", …}
//
// The repo's field names are English (lib/log.ts writes `message`, never `msg`); the account's guide
// (labs, craftech/seguridad-demos/observabilidad.md) calls them msg "acceso", ruta, metodo, estado, ip,
// agente, sub and ms: the README ("Logs") and ADR-0030 keep the equivalence.
//
//   route      the path without the query string, decoded once, ≤ 120 characters, without control
//              characters or line breaks: the procedure names of tRPC (`/api/orders.list,phone.status`)
//   ip         the viewer CloudFront named (`CloudFront-Viewer-Address`, routers/edge.ts `viewerIpOf`, the
//              same value the sign-up and SMS limits count) once the origin check passed; the caller of the
//              Function URL itself (`requestContext.http.sourceIp`) when it did not come through CloudFront;
//              never the first value of `x-forwarded-for`
//   userAgent  `User-Agent`, ≤ 80 characters, sanitized like the route
//   sub        the Cognito `sub` of an id token `createContext` already verified (`noteAccessSub`); nothing
//              here decodes a token
//
// Never the body, the query string, a token, the `authorization` header, an email or a phone: the line
// goes through lib/log.ts, which masks phones and emails left in the user agent too. Writing it never
// changes the answer.
import { AsyncLocalStorage } from "node:async_hooks";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { type Logger, correlationIdFrom } from "../lib/log";

export const ACCESS_MESSAGE = "access";
export const ROUTE_MAX = 120;
export const USER_AGENT_MAX = 80;
const METHOD_MAX = 10;
const IP_MAX = 45;
const SUB_MAX = 64;
const CORRELATION_HEADER = "x-correlation-id";

interface RequestInFlight {
  sub?: string;
  ip?: string;
}

const inFlight = new AsyncLocalStorage<RequestInFlight>();

/** The verified `sub` of the request in flight (outside a wrapped request it does nothing). */
export function noteAccessSub(sub: string | undefined): void {
  const request = inFlight.getStore();
  if (request !== undefined && sub !== undefined && sub.length > 0) request.sub = sub;
}

/** The viewer of the request in flight, as the edge decided it (routers/handler.ts). */
export function noteAccessIp(ip: string | undefined): void {
  const request = inFlight.getStore();
  if (request !== undefined && ip !== undefined && ip.length > 0) request.ip = ip;
}

/** No control characters nor line separators, and at most `max` characters. */
export function sanitize(value: string | undefined, max: number): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").slice(0, max);
}

/** The path without its query string, decoded once (an undecodable one stays raw). */
export function routeOf(event: Pick<APIGatewayProxyEventV2, "rawPath" | "requestContext">): string {
  const raw = (event.rawPath || event.requestContext?.http?.path || "/").split("?")[0] ?? "/";
  let route = raw;
  try {
    route = decodeURIComponent(raw);
  } catch {
    route = raw;
  }
  return sanitize(route, ROUTE_MAX);
}

function headerOf(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const headers = event.headers ?? {};
  return Object.hasOwn(headers, name) ? headers[name] : undefined;
}

export interface AccessLogDeps {
  /** The logger of one request, under its correlation id (the one tRPC's context uses too). */
  readonly logFor: (correlationId: string) => Logger;
  /** Milliseconds of a monotonic-enough clock (the duration only). */
  readonly nowMs: () => number;
}

type Handler<A extends unknown[]> = (event: APIGatewayProxyEventV2, ...rest: A) => Promise<APIGatewayProxyStructuredResultV2>;

function write(deps: AccessLogDeps, event: APIGatewayProxyEventV2, status: number, request: RequestInFlight, ms: number): void {
  const correlationId = correlationIdFrom(headerOf(event, CORRELATION_HEADER) ?? event.requestContext?.requestId);
  deps.logFor(correlationId).info(ACCESS_MESSAGE, {
    route: routeOf(event),
    method: sanitize(event.requestContext?.http?.method, METHOD_MAX).toUpperCase(),
    status,
    ip: sanitize(request.ip, IP_MAX),
    userAgent: sanitize(headerOf(event, "user-agent"), USER_AGENT_MAX),
    ...(request.sub === undefined ? {} : { sub: sanitize(request.sub, SUB_MAX) }),
    ms,
  });
}

/** Wraps an HTTP handler without changing any answer: the access line when it ends, the error thrown again. */
export function withAccessLog<A extends unknown[]>(handler: Handler<A>, deps: AccessLogDeps): Handler<A> {
  return (event, ...rest) => {
    const request: RequestInFlight = {};
    const started = deps.nowMs();
    const record = (status: number) => {
      try {
        write(deps, event, status, request, Math.max(0, Math.round(deps.nowMs() - started)));
      } catch {
        // The access line never changes the answer.
      }
    };
    return inFlight.run(request, async () => {
      try {
        const response = await handler(event, ...rest);
        record(response.statusCode ?? 200);
        return response;
      } catch (error) {
        record(500);
        throw error;
      }
    });
  };
}
