// Web edge of the app: one CloudFront Router on cuadrilla.demo.craftech.io (dns.ts) and the console,
// landing, `/join` and legal pages (packages/web, React 19 + Vite + Tailwind v4) served from `/`.
//
// Route layout of the Router (docs/architecture.md §10-§11); the prefixes and budgets live in
// web-spec.ts, checked by web-spec.test.ts:
//
//   /*              StaticSite Console            (this file)
//   /legal/*.html   static legal pages            (packages/web/public/legal, copied by Vite)
//   /api/*          Function Bff, tRPC            (infra/bff.ts, WP-38)
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
// change it, so a commit cannot loosen the CSP of the console.
//
// Verify (docs/build-plan.md WP-04):
//   curl -sI https://cuadrilla.demo.craftech.io                     → 200 with CSP, HSTS, X-Frame-Options DENY
//   curl -sI https://cuadrilla.demo.craftech.io/legal/privacy.html  → 200, content-type text/html

import { authWebEnvironment } from "./auth";
import { consoleHeadersPolicyName, routerKeyValueStoreName } from "./ci-spec";
import { appDomain, dns } from "./dns";
import { LEGAL_PAGES, STATIC_FILE_OPTIONS, legalUrl } from "./web-spec";

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

function withHeadersPolicy<T extends object>(behavior: $util.Input<T>, policyId: $util.Output<string | undefined>): $util.Output<T> {
  return $util.all([behavior, policyId]).apply(([resolved, id]) => (id ? { ...resolved, responseHeadersPolicyId: id } : resolved) as T);
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
      args.defaultCacheBehavior = withHeadersPolicy(args.defaultCacheBehavior, consoleHeadersPolicyId);
      if (args.orderedCacheBehaviors !== undefined) {
        args.orderedCacheBehaviors = $util
          .output(args.orderedCacheBehaviors)
          .apply((behaviors) => $util.all((behaviors ?? []).map((behavior) => withHeadersPolicy(behavior, consoleHeadersPolicyId))));
      }
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
  // Cognito pool and client (auth.ts, WP-10); read by packages/web/src/lib/env.ts.
  environment: authWebEnvironment,
});
