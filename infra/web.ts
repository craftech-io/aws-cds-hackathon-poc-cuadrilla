// Web edge of the app: one CloudFront Router on cuadrilla.demo.craftech.io (dns.ts) and the console,
// landing, `/join` and legal pages (packages/web, React 19 + Vite + Tailwind v4) served from `/`.
//
// Route layout of the Router (docs/architecture.md §10-§11); the prefixes and budgets live in
// web-spec.ts, checked by web-spec.test.ts:
//
//   /*              StaticSite Console            (this file)
//   /legal/*.html   static legal pages            (packages/web/public/legal, copied by Vite)
//   /api/*          Function Bff, tRPC            (infra/bff.ts: the minimal Bff of WP-56, then WP-38)
//
// There is no public upload surface: `/api/*` is the only Lambda route. It attaches from bff.ts with
// the function's own `url.router` prop (`{ instance: router, path }`); the Router declares no inline
// `routes`, because a Router with inline routes cannot be targeted by the `router` prop of other
// components. The Router keeps `protection: "none"`: Origin Access Control would overwrite the
// `Authorization: Bearer <id token>` header the console sends to the BFF, and plain `oac` cannot
// sign the bodies of POST requests.
//
// Routing table: the Router keeps its routes in a CloudFront key-value store, whose ARN carries an
// opaque id no IAM statement can predict. The store is the one the CI bootstrap creates
// (infra/bootstrap/ci-role.yaml, RouterKeyValueStore), the only store the deploy role may write, so
// a commit cannot rewrite the routes of another Router of the account.
//
// Security headers (CSP, HSTS, no framing, nosniff, referrer): the response headers policy the
// bootstrap creates, read by name and attached to every cache behavior. The deploy role cannot
// change it, so a commit cannot loosen the CSP of the console. The CSP allows the AWS WAF SDK
// (`*.sdk.awswaf.com`) and token (`*.token.awswaf.com`) hosts the sign-up's silent challenge uses.
//
// Edge of the BFF (ADR-0025 §3 and §4), all through `transform.cdn`, the only place the Router lets a
// module shape its distribution:
//   - web ACL: the edge ACL of infra/waf.ts on the distribution (`webAclId`).
//   - origin header: `x-cuadrilla-origin: <OriginVerifyKey>` as an origin custom header of the
//     distribution's default origin. The Router routes every request with `cf.updateRequestOrigin`
//     without `customHeaders`, and CloudFront then keeps the assigned origin's custom headers, so every
//     origin request carries it (the S3 origin of the console too, which ignores it); CloudFront
//     overwrites a viewer's header of the same name. The value lives in the distribution's
//     configuration (readable with CloudFront read access, a declared residual risk).
//   - `/api/*` behavior: a copy of the default behavior (same viewer-request routing function, cache
//     policy and security headers) with the bootstrap's origin request policy, which forwards every
//     viewer value, the headers AWS WAF inserts and `CloudFront-Viewer-Address`. The console keeps
//     SST's AllViewerExceptHostHeader.
//
// Build variables of the console: the pool and its clients (auth.ts) and the edge ACL's integration
// URL (`challenge.js` of the silent challenge, packages/web/src/lib/waf-token.ts).
//
// Verify (docs/build-plan.md WP-04):
//   curl -sI https://cuadrilla.demo.craftech.io                     → 200 with CSP, HSTS, X-Frame-Options DENY
//   curl -sI https://cuadrilla.demo.craftech.io/legal/privacy.html  → 200, content-type text/html

import { WEB_ENV_NAMES } from "./auth-email";
import { authWebEnvironment } from "./auth";
import { consoleHeadersPolicyName, routerKeyValueStoreName } from "./ci-spec";
import { appDomain, dns } from "./dns";
import { OriginVerifyKey } from "./secrets";
import { edgeWebAcl, wafIntegrationUrl } from "./waf";
import { API_PATH_PATTERN, LEGAL_PAGES, ORIGIN_VERIFY_HEADER, STATIC_FILE_OPTIONS, apiOriginRequestPolicyName, legalUrl } from "./web-spec";

export { API_PATH, LEGAL_PAGES } from "./web-spec";

/** Public URLs of the legal pages. */
export const legalUrls = {
  privacy: legalUrl(appDomain, "privacy"),
  terms: legalUrl(appDomain, "terms"),
} as const satisfies Record<keyof typeof LEGAL_PAGES, string>;

// Read by name (CloudFront's id for a store), created by the bootstrap.
const bootstrapKvStoreArn = aws.cloudfront.KeyValueStore.get("RouterBootstrapKvStore", routerKeyValueStoreName($app.name, $app.stage)).arn;

// Security headers: the policy the bootstrap creates, read by name. The console takes the password
// and the TOTP code itself, so a script it did not ship must not run and no other site may frame it;
// images and audio come only from its own origin and the three browser buckets (infra/ci-spec.ts).
const consoleHeadersPolicyId = aws.cloudfront.getResponseHeadersPolicyOutput({ name: consoleHeadersPolicyName($app.name, $app.stage) }).id;

// `/api/*`: the origin request policy the bootstrap creates, read by name.
const apiOriginRequestPolicyId = aws.cloudfront.getOriginRequestPolicyOutput({ name: apiOriginRequestPolicyName($app.name, $app.stage) }).id;

function withHeadersPolicy<T extends object>(behavior: $util.Input<T>, policyId: $util.Output<string | undefined>): $util.Output<T> {
  return $util.all([behavior, policyId]).apply(([resolved, id]) => (id ? { ...resolved, responseHeadersPolicyId: id } : resolved) as T);
}

type CdnArgs = sst.aws.CdnArgs;
type OrderedBehavior = NonNullable<$util.Unwrap<CdnArgs["orderedCacheBehaviors"]>>[number];

/** The default behavior of the Router, for `/api/*`, with the origin request policy of the bootstrap. */
function apiBehavior(defaults: CdnArgs["defaultCacheBehavior"]): $util.Output<OrderedBehavior> {
  return $util.all([defaults, apiOriginRequestPolicyId]).apply(([behavior, policyId]) => {
    if (!policyId) throw new Error(`The origin request policy ${apiOriginRequestPolicyName($app.name, $app.stage)} does not exist: apply infra/bootstrap/ci-role.yaml.`);
    return { ...behavior, pathPattern: API_PATH_PATTERN, originRequestPolicyId: policyId } as OrderedBehavior;
  });
}

/** Every origin of the distribution carries the origin header (the Router's routing inherits it). */
function withOriginHeader(origins: CdnArgs["origins"]): $util.Output<$util.Unwrap<CdnArgs["origins"]>> {
  return $util.all([origins, OriginVerifyKey.value]).apply(([list, key]) =>
    list.map((origin) => ({ ...origin, customHeaders: [...(origin.customHeaders ?? []).filter((header) => header.name !== ORIGIN_VERIFY_HEADER), { name: ORIGIN_VERIFY_HEADER, value: key }] })),
  );
}

export const router = new sst.aws.Router("Router", {
  domain: {
    name: appDomain,
    dns,
  },
  // OAC would clobber the Bearer token of the console. Each handler authenticates itself.
  protection: "none",
  // No code is injected; the store only replaces the one SST would create (see the header).
  edge: { viewerRequest: { injection: "", kvStore: bootstrapKvStoreArn } },
  transform: {
    cdn: (args) => {
      args.webAclArn = edgeWebAcl.arn;
      args.origins = withOriginHeader(args.origins);
      const ordered = $util.all([args.orderedCacheBehaviors ?? [], apiBehavior(args.defaultCacheBehavior)]).apply(([behaviors, api]) => [api, ...(behaviors ?? [])]);
      args.orderedCacheBehaviors = ordered.apply((behaviors) => $util.all(behaviors.map((behavior) => withHeadersPolicy(behavior, consoleHeadersPolicyId))));
      args.defaultCacheBehavior = withHeadersPolicy(args.defaultCacheBehavior, consoleHeadersPolicyId);
    },
  },
});

export const consoleSite = new sst.aws.StaticSite("Console", {
  path: "packages/web",
  build: {
    command: "npm run build",
    output: "dist",
  },
  // Single-page app: unknown paths fall back to index.html (the default errorPage), so the
  // client-side router of the console resolves them.
  indexPage: "index.html",
  // Hashed bundles immutable, HTML never cached, legal pages public for five minutes (web-spec.ts).
  assets: {
    textEncoding: "utf-8",
    fileOptions: STATIC_FILE_OPTIONS.map((option) => ({ ...option })),
  },
  router: {
    instance: router,
  },
  // Cognito pool and clients (auth.ts) and the challenge host of AWS WAF; read by packages/web/src/lib/env.ts.
  environment: { ...authWebEnvironment, [WEB_ENV_NAMES.wafIntegrationUrl]: wafIntegrationUrl },
});
