// AWS WAF of the app (ADR-0025 §4, ADR-0030, docs/architecture.md §1 and §10).
//
//   demos-borde  the account's shared CLOUDFRONT web ACL (craftech/demos creates and keeps it). Looked up
//                by name on every deploy and put on the Router's distribution (`webAclArn`, infra/web.ts);
//                this app never creates, changes or deletes it. It must exist before the deploy.
//   AuthWebAcl   <app>-<stage>-auth, REGIONAL, associated here with the Cognito user pool: the API of
//                the pool is public (the browser calls SignUp, ConfirmSignUp and the sign-in directly).
//
// The pool's rules go as `ruleJson` (the API's `Rules`), exactly as infra/waf-spec.ts states them. There
// is no drift detection on `ruleJson`: SC-20/10 (`waf.probe`) compares the live ACL with the spec.
//
// Fences: the CI role manages `wafv2` only on web ACLs named `<app>-*` (both scopes), reads only
// `demos-borde` among the others (ListWebACLs to find it, GetWebACL on it) and associates the pool's ACL
// only with a pool tagged `sst:app` = this app (infra/bootstrap/ci-role.yaml). No API key of AWS WAF
// exists (no CAPTCHA). No logging configuration here: the shared ACL's logs belong to craftech/demos.
//
// Verify:
//   aws --profile craftech-demos wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 --query "WebACLs[?Name=='demos-borde'].ARN"
//   aws --profile craftech-demos cloudfront get-distribution-config --id <Router distribution> --query DistributionConfig.WebACLId   → the ARN above
//   aws --profile craftech-demos wafv2 get-web-acl-for-resource --resource-arn <user pool ARN>   → …-poc-auth

import { userPool } from "./auth";
import { SHARED_EDGE_WEB_ACL, webAclSpec } from "./waf-spec";

/** The shared edge ACL, by name: a lookup on every deploy, never a resource of this app. */
export const sharedEdgeWebAcl = aws.wafv2.getWebAclOutput({ name: SHARED_EDGE_WEB_ACL, scope: "CLOUDFRONT" });

const authSpec = webAclSpec("auth");

export const authWebAcl = new aws.wafv2.WebAcl("AuthWebAcl", {
  name: authSpec.name,
  description: authSpec.description,
  scope: authSpec.scope,
  region: "us-east-1",
  defaultAction: authSpec.defaultAction,
  ruleJson: JSON.stringify(authSpec.rules),
  visibilityConfig: authSpec.visibilityConfig,
});

export const authWebAclAssociation = new aws.wafv2.WebAclAssociation("AuthWebAclAssociation", {
  resourceArn: userPool.arn,
  webAclArn: authWebAcl.arn,
});
