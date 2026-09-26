// Path handling of the console BFF, kept free of the router tree so infra/ tests can import it.
import type { APIGatewayProxyEventV2 } from "aws-lambda";

/** Path the Router forwards to this function; the web client calls `/api/<procedure>`. */
export const API_PREFIX = "/api";

/** `GET /api/health`, the probe of the Router and the smoke checks, is the public `health.live`. */
const PATH_ALIASES: ReadonlyMap<string, string> = new Map([["/health", "/health.live"]]);

// The adapter takes the procedure name from `rawPath`. Behind the Router it arrives as
// `/api/orders.list`; called on the Function URL directly (smoke tests) it is `/orders.list`.
export function stripApiPrefix(event: APIGatewayProxyEventV2): APIGatewayProxyEventV2 {
  const { rawPath } = event;
  const stripped = rawPath === API_PREFIX || rawPath.startsWith(`${API_PREFIX}/`) ? rawPath.slice(API_PREFIX.length) || "/" : rawPath;
  const target = PATH_ALIASES.get(stripped) ?? stripped;
  if (target === rawPath) return event;
  return { ...event, rawPath: target, requestContext: { ...event.requestContext, http: { ...event.requestContext.http, path: target } } };
}
