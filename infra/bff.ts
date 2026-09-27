// The console BFF on `/api/*` (docs/architecture.md §10 and §14, ADR-0025 §3): tRPC v11 behind the
// Router, its Function URL with auth NONE (OAC would clobber the console's `Authorization: Bearer`
// and cannot sign POST bodies). WP-56 brings the MINIMAL Bff of the own sign-up (wave 2b); WP-38
// adds the rest of its row of infra/iam-capabilities.ts (the queue, the mocks, the simulator, the
// world janitor, presigned URLs) and the QaDriver and PolicyAudit.
//
// The edge is the only way in. The Router adds the origin header `x-cuadrilla-origin` with the value
// of `OriginVerifyKey` on every origin request (infra/web.ts, an origin custom header of the
// distribution; CloudFront overwrites a viewer's header of the same name) and forwards
// `CloudFront-Viewer-Address` and the headers AWS WAF inserts on `/api/*` (AWS's
// AllViewerExceptHostHeader, infra/web-spec.ts). `routers/handler.ts` answers 403 without a body, before parsing, to any request
// without the header or with another value, so the Function URL called directly skips neither the
// web ACL nor the viewer's IP (smoke: scripts/smoke/interim.ts).
//
// Links: the demo's tables and buckets of its row (by name; data access by `storagePermissions`),
// `Leads` with the form's attributes only (BFF_LEADS_GRANT: `LEAD#*` keys, `dynamodb:Attributes`,
// bounded ReturnValues), `Runtime` for the sign-up's limits, the pool's public facts (`Auth`: tokens
// are verified offline), the secrets `SessionTokenKey`, `BrandConfig` and `OriginVerifyKey`, the cost
// caps, and GuestWorlds (`guest.retryWorld`) and GuestAccountDeletion (`account.deleteGuest`), whose
// links grant InvokeFunction on them alone. No SES, no End User Messaging, no Bedrock.
//
// Verify:
//   curl -s -o /dev/null -w "%{http_code}" -X POST "<Bff Function URL>api/signup.start"   → 403, empty body
//   curl -s https://cuadrilla.demo.craftech.io/api/health                               → {"result":{"data":{"ok":true,…}}}

import { Auth } from "./auth";
import { CostCaps } from "./cost-caps";
import { guestWorlds } from "./guest-worlds";
import { BFF_LEADS_GRANT } from "./leads-spec";
import { Leads, grantStatement, guestAccountDeletion } from "./leads";
import { BrandConfig, OriginVerifyKey, SessionTokenKey } from "./secrets";
import { storageLinks, storagePermissions } from "./storage";
import { API_PATH, EDGE_BUDGETS } from "./web-spec";
import { router } from "./web";

/** Entry of the tRPC handler (WP-13; the origin check and the sign-up's shape by WP-57). */
export const BFF_HANDLER = "packages/bff/src/routers/handler.handler";

const budget = EDGE_BUDGETS.bff;

export const bff = new sst.aws.Function("Bff", {
  description: "Console BFF (tRPC) behind the Router; answers 403 to any request without the origin header.",
  handler: BFF_HANDLER,
  url: {
    authorization: "none",
    // Same origin as the console: no CORS.
    cors: false,
    router: { instance: router, path: API_PATH, readTimeout: `${budget.routerReadTimeoutSeconds} seconds` },
  },
  link: [...storageLinks("Bff"), Leads, Auth, SessionTokenKey, BrandConfig, OriginVerifyKey, CostCaps, guestWorlds, guestAccountDeletion],
  permissions: [...storagePermissions("Bff"), grantStatement(BFF_LEADS_GRANT), grantStatement({ actions: ["s3:GetObject"], resources: ["{Seed}/brand/*"] })],
  timeout: `${budget.timeoutSeconds} seconds`,
  memory: `${budget.memoryMb} MB`,
  concurrency: { reserved: budget.reservedConcurrency },
});
