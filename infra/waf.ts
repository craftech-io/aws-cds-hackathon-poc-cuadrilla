// AWS WAF of the app (ADR-0025 §4, docs/architecture.md §1 and §10): the two web ACLs of
// infra/waf-spec.ts, exactly as that file states them (checked by infra/waf-spec.test.ts).
//
//   EdgeWebAcl   <app>-<stage>-edge, CLOUDFRONT (created in us-east-1). infra/web.ts puts its ARN on the
//                Router's distribution (`webAclId`), so it sees every request before the Bff does.
//   AuthWebAcl   <app>-<stage>-auth, REGIONAL, associated here with the Cognito user pool: the API of
//                the pool is public (the browser calls SignUp, ConfirmSignUp and the sign-in directly).
//
// The rules go as `ruleJson` (the API's `Rules`): the sign-up scope nests an OR inside an AND inside the
// scope-down of a rate rule, one level deeper than the typed `rules` of the provider can express. The
// provider base64-encodes every `SearchString` of the JSON itself, so the spec keeps them in plain text.
// There is no drift detection on `ruleJson`: SC-20/10 (`waf.probe`) compares the live ACLs with the spec.
//
// The integration URL of the edge ACL (the host of the silent challenge's `challenge.js`) reaches the
// console's build as a variable (infra/web.ts); the CSP of the bootstrap allows the AWS WAF hosts by
// wildcard because that URL is born with the ACL, after the bootstrap is applied.
//
// Fences: the CI role manages `wafv2` only on web ACLs named `<app>-*` (both scopes) and associates the
// pool's ACL only with a pool tagged `sst:app` = this app (infra/bootstrap/ci-role.yaml). No API key
// of AWS WAF exists (no CAPTCHA). No logging configuration (full logs would keep IPs).
//
// Verify:
//   aws --profile craftech-demos wafv2 get-web-acl --scope CLOUDFRONT --region us-east-1 --name aws-cds-hackathon-poc-cuadrilla-poc-edge --id <id>
//   aws --profile craftech-demos wafv2 get-web-acl-for-resource --resource-arn <user pool ARN>   → …-poc-auth
//   aws --profile craftech-demos cloudfront get-distribution-config --id <Router distribution> --query DistributionConfig.WebACLId

import { userPool } from "./auth";
import { webAclSpec, type WebAclKind } from "./waf-spec";

function webAcl(logicalName: string, kind: WebAclKind): aws.wafv2.WebAcl {
  const spec = webAclSpec(kind);
  return new aws.wafv2.WebAcl(logicalName, {
    name: spec.name,
    description: spec.description,
    scope: spec.scope,
    // A CLOUDFRONT web ACL lives in us-east-1, the app's region.
    region: "us-east-1",
    defaultAction: spec.defaultAction,
    ruleJson: JSON.stringify(spec.rules),
    visibilityConfig: spec.visibilityConfig,
  });
}

export const edgeWebAcl = webAcl("EdgeWebAcl", "edge");
export const authWebAcl = webAcl("AuthWebAcl", "auth");

export const authWebAclAssociation = new aws.wafv2.WebAclAssociation("AuthWebAclAssociation", {
  resourceArn: userPool.arn,
  webAclArn: authWebAcl.arn,
});

/** Host of `challenge.js` for the console build (`VITE_WAF_INTEGRATION_URL`). Not a secret. */
export const wafIntegrationUrl = edgeWebAcl.applicationIntegrationUrl;
