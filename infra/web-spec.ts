// Route layout, budgets and static-asset policy of the web edge as plain data and pure functions.
// No SST or Pulumi dependency: infra/web.ts and infra/bff.ts build the resources from this file, and
// infra/web-spec.test.ts checks every value against the constraints below without an AWS account.
//
// Constraints, verified against SST 4.17.1 (platform/src/components/aws/router.ts):
//   - The Router matches routes by path prefix on segment boundaries and the longest prefix wins, so
//     `/api` never captures `/apix`.
//   - A route's `readTimeout` (CloudFront origin response timeout) must be 1..60 seconds without a
//     CloudFront quota increase.
//   - The Router forwards the full path: nothing is rewritten, each handler owns its prefix
//     (routers/handler.ts strips `/api`). There is no public upload surface (docs/reuse-map.md).

// ---- Routes ------------------------------------------------------------------------------------

/** Path prefix of the tRPC BFF (Function `Bff`); the console calls `/api/<procedure>`. */
export const API_PATH = "/api";

/** Static legal pages served by the console bucket (packages/web/public/legal). */
export const LEGAL_PATH = "/legal";

export const LEGAL_PAGES = {
  privacy: `${LEGAL_PATH}/privacy.html`,
  terms: `${LEGAL_PATH}/terms.html`,
} as const;

export type LegalPage = keyof typeof LEGAL_PAGES;

/** Every Lambda route of the Router, by function. The StaticSite owns `/` and everything else. */
export const LAMBDA_ROUTES = {
  bff: API_PATH,
} as const;

export type EdgeFunction = keyof typeof LAMBDA_ROUTES;

/** Absolute URL of a legal page on the app domain. */
export function legalUrl(domain: string, page: LegalPage): string {
  return `https://${domain}${LEGAL_PAGES[page]}`;
}

/** Same matching rule as the Router's CloudFront function: prefix on a segment boundary. */
export function routeMatches(prefix: string, uri: string): boolean {
  if (prefix === "/") return true;
  return uri.startsWith(prefix) && (uri.length === prefix.length || prefix.endsWith("/") || uri[prefix.length] === "/");
}

/** The Lambda route that serves a URI, longest prefix first; `undefined` → the console bucket. */
export function lambdaRouteFor(uri: string): EdgeFunction | undefined {
  const candidates = (Object.entries(LAMBDA_ROUTES) as Array<[EdgeFunction, string]>)
    .filter(([, prefix]) => routeMatches(prefix, uri))
    .sort(([, a], [, b]) => b.length - a.length);
  return candidates[0]?.[0];
}

// ---- Budgets -----------------------------------------------------------------------------------

/** CloudFront's ceiling for the origin response timeout without a quota increase. */
export const ROUTER_READ_TIMEOUT_MAX_SECONDS = 60;

export interface EdgeFunctionBudget {
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
  /** CloudFront origin response timeout of the route. */
  readonly routerReadTimeoutSeconds: number;
  /** Reserved concurrency (docs/architecture.md §12). */
  readonly reservedConcurrency: number;
}

export const EDGE_BUDGETS: Readonly<Record<EdgeFunction, EdgeFunctionBudget>> = {
  // Console procedures read DynamoDB, enqueue work and presign URLs: a buffered response must arrive
  // before CloudFront gives up, so the Lambda ends first.
  bff: { timeoutSeconds: 28, memoryMb: 1024, routerReadTimeoutSeconds: 30, reservedConcurrency: 10 },
};

// ---- Static assets -----------------------------------------------------------------------------

export interface StaticFileOption {
  readonly files: string;
  readonly cacheControl: string;
  readonly contentType?: string;
}

/**
 * Upload policy of the console bucket. SST applies the entries in reverse order and a file takes the
 * first entry that matches it, so the LAST matching entry wins:
 *   - `assets/**`: Vite's content-hashed bundles, immutable for a year;
 *   - any other file copied from packages/web/public (Craftech logos, landing captures): one hour;
 *   - HTML never cached, so a deploy is visible at once (index.html points at the new bundle);
 *   - the legal pages: public, five minutes, explicit UTF-8 so the Spanish text renders everywhere.
 */
export const STATIC_FILE_OPTIONS: readonly StaticFileOption[] = [
  { files: "**", cacheControl: "max-age=3600,public" },
  { files: "assets/**", cacheControl: "max-age=31536000,public,immutable" },
  { files: "**/*.html", cacheControl: "max-age=0,no-cache,no-store,must-revalidate" },
  { files: `${LEGAL_PATH.slice(1)}/*.html`, cacheControl: "max-age=300,public", contentType: "text/html; charset=utf-8" },
];
