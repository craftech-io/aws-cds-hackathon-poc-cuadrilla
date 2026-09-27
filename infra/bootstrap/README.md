# CI bootstrap

`ci-role.yaml` creates the only infrastructure that must exist before the first `sst deploy`
(ADR-0009, ADR-0007, `docs/architecture.md` §15 step 2):

- Permissions boundary `<app>-ci-boundary`, stamped on every role of the app by `infra/ci.ts`.
  Whatever policy a commit attaches, a role reaches only this app, one region, no IAM management
  and no role assumption.
- Deploy role `<app>-github-deploy`, assumed by `.github/workflows/deploy.yml` on `main`, with the
  managed policies `<app>-ci-deploy-{sst-home,app-resources,named,edge,dns-and-iam}`.
- Role `<app>-qa-runner`, assumed by `deploy.yml` (smoke) and `scenarios.yml` (full suite and
  evaluation) on `main`: it can only invoke `function:<app>-poc-qa-driver` and read the app's logs.
- Key-value store `<app>-poc-router`, the routing table of the Router (`infra/web.ts`).
- Response headers policy `<app>-poc-console` (CSP, HSTS, `X-Frame-Options DENY`, nosniff,
  referrer), which the deploy role cannot change. Its CSP is `CONSOLE_CSP` of `infra/ci-spec.ts`:
  uploads only to `Media`, images and audio only from `Media`, `Evidence` and `Seed` (the design
  partner's logos under `Seed/brand/`), scripts from the app and the AWS WAF SDK
  (`https://*.sdk.awswaf.com`) and calls to AWS WAF's token hosts (`https://*.token.awswaf.com`):
  the silent challenge of the sign-up (ADR-0025 §4). Wildcards because the integration URL is born
  with the web ACL, after this template is applied. The AWS WAF guide ("Using the JavaScript API
  with content security policies") allowlists the apex `https://*.awswaf.com` in `script-src`,
  `script-src-elem` and `connect-src`; the console narrows it to the SDK and token hosts it uses.
- Origin request policy `<app>-poc-api` for `/api/*` of the Router (ADR-0025 §3): every viewer
  header, cookie and query string (the headers AWS WAF inserts included) plus
  `CloudFront-Viewer-Address`, which the managed `AllViewerExceptHostHeader` (`allExcept [host]`)
  does not forward. The deploy role only reads it; `infra/web.ts` finds it by name.
- Optionally the GitHub OIDC provider, only for an account that has none.

Explanations live here, not in the template: CloudFormation accepts 51,200 bytes inline and IAM
6,144 characters per managed policy (`ci-role.test.ts` checks both; `ci-role-fences.test.ts` checks
every fixed name of `docs/architecture.md` §1 against a statement with its exact ARN).

## Parameters

| Parameter | Value | Notes |
|---|---|---|
| `AppName` | `aws-cds-hackathon-poc-cuadrilla` | Default; every name and fence derives from it |
| `BucketPrefix` | `aws-cds-hackathon-poc-cua` | Recomputed by `infra/ci-spec.test.ts` (`bucketPrefix`) |
| `AppDomain` | `cuadrilla.demo.craftech.io` | SES identity and DNS records |
| `AgentNamePrefix` | `aws_cds_hackathon_poc_cuadrilla` | Runtime AgentCore creates under the Harness |
| `GitHubOrg` / `GitHubRepo` | `craftech-io` / `aws-cds-hackathon-poc-cuadrilla` | Trust of both roles |
| `GitHubOrgId` / `GitHubRepoId` | Mandatory, numeric | Provided by the operator (`gh api …`); no default |
| `WhatsAppPhoneNumberArn` | Empty until `docs/pending.md` P-01 | ARN of the app's own number; while empty, the boundary grants no End User Messaging Social action at all |
| `RouterCachePolicyId` | `none` | Only when a cache policy must be changed by id |

## How every statement is fenced

```text
The demos account is SHARED with another project, so every statement is scoped to this app:

  tag    aws:ResourceTag/sst:app = <app>, stamped by the provider default tags (sst.config.ts)
         and by infra/tags.ts on awsnative.*. Used wherever the service authorizes by tag
         (Lambda, SQS, SNS, EventBridge, Scheduler, Cognito, SES, Bedrock, AgentCore…).
  name   ARN prefix where the physical name keeps the app name whole (DynamoDB, SNS, SQS, event
         buses, schedule groups, the budget, CloudFront functions, the vector bucket kb-<app>-*,
         Transcribe jobs and vocabularies cuadrilla-poc-*), where tags cannot be used (S3, by
         BucketPrefix) or are not there yet (reads before and right after a create).
  path   every IAM role and policy of the app lives under /<app>/ (infra/ci.ts). The path is part
         of the ARN and cannot be forged with a tag, so it fences IAM.
  ARN    fixed names: the WhatsApp topic <app>-wa-inbound, the configuration set <app>-email-poc,
         the QA driver <app>-poc-qa-driver, the WhatsApp number (parameter), the Router key-value
         store and cache policy.
```

What each group of statements is for:

| Statement | Why |
|---|---|
| `TaggedAppResources` / `CreateTaggedAsThisApp` | Everything after creation only on resources tagged as the app; creation (including the manual's Knowledge Base) only when the request tags the new resource as the app. Ingestion jobs of `seed:load` act on the tagged Knowledge Base |
| `NamedAppResources` | DynamoDB tables `<app>-*`, buckets `<BucketPrefix>*` (S3 cannot be conditioned on tags; this covers `Manual/manual/*`, `Seed/*` and the vocabulary file `Seed/transcribe/*`, which Transcribe reads with the deploy role's credentials) and the vector bucket `kb-<app>-*` (S3 Vectors reserves every name that starts with `aws`) |
| `NoResourceLevelDeployVocabulary{Create,TagKeys,TagReads}` | Transcribe has no resource type for `CreateVocabulary`, `TagResource`, `UntagResource` and `ListTagsForResource`: `Resource *`, fenced by `aws:RequestTag/Project` on create, by `aws:TagKeys` (only the app's tag keys) on tag and untag; the tag read has no condition because the provider calls it right after the create and on every refresh. Same four statements in the deploy role and in the boundary |
| `VocabulariesOfThisApp` | `Get/Update/DeleteVocabulary` by ARN `vocabulary/cuadrilla-poc-*` |
| `TranscriptionJobsOfThisApp` / `NoResourceLevelRuntime` (boundary) | App roles read and delete only `transcription-job/cuadrilla-poc-*`; `StartTranscriptionJob` has no resource type, so it is on `*` in the boundary and fenced by output bucket and key in the role policies (`infra/iam-capabilities.ts`) |
| `WhatsAppOfThisNumber` (boundary) | `SendWhatsAppMessage`, `PostWhatsAppMessageMedia` and `GetWhatsAppMessageMedia` only on `WhatsAppPhoneNumberArn`; omitted while it is empty. No role ever gets `PutWhatsAppBusinessAccountEventDestinations` or a WABA association: the operator applies the event destination with `scripts/channels/waba-event-destination.ts` |
| `TopicsAndQueuesOfThisApp`, `SchedulerGroupsOfThisApp`, `EventBusesOfThisApp` | The provider reads a named topic, queue, group or bus before IAM can see its tags |
| `ProjectBudget` / `DenyBudgetsOfOtherProjects` | The monthly budget `<app>-*` of ADR-0019, and no other budget of the account |
| `DenyPublicFunctionUrlsBesidesTheEdge` | A Function URL with `AuthType NONE` only on `Bff`; the mocks, the QA driver and every other function keep `AWS_IAM` |
| `HarnessUnderlyingRuntime` | The runtime AgentCore creates under the Harness, named `harness_<AgentNamePrefix>*` |
| `CloudControlTransport` | `awsnative.*` resources go through the Cloud Control API, IAM prefix `cloudformation` |
| Edge policy | CloudFront functions `<app>-poc-*`, the bootstrap key-value store and the declared cache policy only; reads of the origin request and cache policies of `/api/*` |
| `WebAclsOfThisApp` (edge policy) | Create, update, delete, tag and associate only the web ACLs `<app>-*` of both scopes (`<app>-poc-edge` on the Router, `<app>-poc-auth` on the user pool). AWS WAF has no tag fence on create, so the fence is the name |
| `ManagedRuleGroupReads` (edge policy) | Read AWS's managed rule groups the ACLs reference (IP reputation, anonymous IP list) and check capacity. No action on AWS WAF API keys exists anywhere: no CAPTCHA (ADR-0025 §4) |
| `CognitoWebAclAssociation` | `AssociateWebACL`, `DisassociateWebACL` and `GetWebACLForResource` of Cognito only on a pool tagged `sst:app` = this app (the pool's ARN has an opaque id) |
| `EventSourceMappingsOfThisApp` | Create, update and delete event source mappings only onto functions `<app>-*` (`lambda:FunctionArn`): the installer queue and the `Leads` stream |
| `SesEventDestinationsOfThisApp` | Event destinations only on the configuration set `<app>-email-poc`: EventBridge for ChannelEvents and CloudWatch by `kind` for the cut of the sign-up |
| `WebAclReadsOfThisApp` (boundary) | App roles may read only the app's two web ACLs (the QaDriver's `waf.probe`) |
| `InvokeAccountDeletionByName` (boundary) | `GuestAccountDeletion` has the fixed name `<app>-poc-guest-account-deletion`: the operator invokes it by name (`npm run leads:delete`) and app roles only through their own grants |

What is deliberately absent: every SES receipt-rule action and any inbound mail bucket (this app
never receives email, ADR-0003; the only active rule set of the account belongs to another project),
`phone-number-id/*`, and Amazon Polly (the synthetic voice notes are generated once by the operator
with `npm run seed:voices` and committed with their data sheet; CI never calls Polly).

## Apply

Once per account, operator present, never from CI. First the read-only pre-checks of step 0 (SES
in production, OIDC provider, SST bootstrap, models, cost tag). The active SES receipt rule set is
neither read nor touched: it belongs to the other project.

```bash
aws --profile craftech-demos sesv2 get-account
aws --profile craftech-demos iam list-open-id-connect-providers
aws --profile craftech-demos ssm get-parameter --name /sst/bootstrap --query Parameter.Name
```

Then the repository ids (`gh api orgs/craftech-io --jq .id` → 60447213 and
`gh api repos/craftech-io/aws-cds-hackathon-poc-cuadrilla --jq .id`) and the stack. Pass
`CreateOidcProvider=true` only when `token.actions.githubusercontent.com` is not listed. After
P-01, apply again with `WhatsAppPhoneNumberArn=<arn of phoneNumbers[].arn>`.

```bash
aws --profile craftech-demos cloudformation deploy \
  --stack-name aws-cds-hackathon-poc-cuadrilla-ci-bootstrap \
  --template-file infra/bootstrap/ci-role.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides CreateOidcProvider=false GitHubOrgId=60447213 GitHubRepoId=<id> \
  --tags Project=aws-cds-hackathon-poc-cuadrilla ManagedBy=cloudformation Owner=craftech
```

The same command applies every later change. Edit statements, not the `Description` of a managed
policy: IAM cannot change it in place and the replacement fails with `already exists`.

**Wave 2b (own sign-up, WAF, leads).** The template changed (web ACLs, Cognito association, event
source mappings, SES event destinations, the CSP with AWS WAF's hosts and the origin request and
cache policies of `/api/*`; the cache policy keeps `Authorization` on the console's `GET` queries): the operator applies it again with the command above **before** the push that deploys
the wave, loads the new secrets `OriginVerifyKey` and `LeadConfig` (`infra/secrets.ts`), and checks
the new statements with `simulate-principal-policy` (below). Before the pool changes, the operator
records whether the live pool distinguishes case in usernames (it cannot change on an existing pool;
the email always arrives lowercased, so either value keeps one account per email):

```bash
aws --profile craftech-demos cognito-idp describe-user-pool --user-pool-id <id> --query UserPool.UsernameConfiguration
```

The SST bootstrap of the account and the stage passphrase are created by the operator's first
`npx sst secret set ... --stage poc` (step 3), never by CI.

## Verify

```bash
aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-cuadrilla-github-deploy
aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-cuadrilla-qa-runner
aws --profile craftech-demos iam get-policy --policy-arn arn:aws:iam::776805327629:policy/aws-cds-hackathon-poc-cuadrilla-ci-boundary
```

The deploy role must be denied on resources of the other project of the shared account and on the
receipt rule API:

```bash
aws --profile craftech-demos iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-cuadrilla-github-deploy \
  --action-names dynamodb:Scan dynamodb:DeleteTable \
  --resource-arns <arn of a table of another project>
aws --profile craftech-demos iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-cuadrilla-github-deploy \
  --action-names ses:SetActiveReceiptRuleSet ses:CreateReceiptRule
```

Repeat with `cloudfront:UpdateFunction` on a function ARN of another project, with
`budgets:ModifyBudget` on another budget, with `transcribe:DeleteVocabulary` on a vocabulary
outside `cuadrilla-poc-*`, and with `bedrock-agentcore:CreatePolicy`, `UpdatePolicy` and
`DeletePolicy` on a policy engine (and one of its policies) whose name does not start with
`aws_cds_hackathon_poc_cuadrilla_poc`. `simulate-principal-policy` does not model every condition key, so a real
deploy is the final check.

The wave-2b statements: the deploy role is allowed on its own web ACLs and denied on another's, and
has no action on AWS WAF API keys:

```bash
aws --profile craftech-demos iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-cuadrilla-github-deploy \
  --action-names wafv2:CreateWebACL wafv2:UpdateWebACL wafv2:AssociateWebACL \
  --resource-arns arn:aws:wafv2:us-east-1:776805327629:global/webacl/aws-cds-hackathon-poc-cuadrilla-poc-edge/x \
                  arn:aws:wafv2:us-east-1:776805327629:regional/webacl/aws-cds-hackathon-poc-cuadrilla-poc-auth/x
aws --profile craftech-demos iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-cuadrilla-github-deploy \
  --action-names wafv2:UpdateWebACL wafv2:DeleteWebACL wafv2:CreateAPIKey \
  --resource-arns <arn of a web ACL of another project>
```

## Residual risks

Stated instead of hidden.

- **Demo recipients.** `ses:Recipients` in the runtime policies lists the SES mailbox simulator;
  the registered demo recipients of `SeedOverrides` are fenced in code (the recipient fence of the
  SES client), not in IAM, when the secret is not readable at deploy time.
- **Public Function URL.** `Bff` answers on a Function URL with `AuthType NONE` behind the Router
  and authenticates every call with the Cognito id token. Its name is fenced by
  `DenyPublicFunctionUrlsBesidesTheEdge`. Called directly it answers 403 before parsing: the Router
  adds `x-cuadrilla-origin` with `OriginVerifyKey` on every origin request. That value lives in the
  distribution's configuration, readable by whoever can read CloudFront in the account (ADR-0025,
  residual risk 2); rotating it is `sst secret set` and a deploy.
- **Managed rule group reads on `*`.** `ManagedRuleGroupReads` describes and lists AWS's managed
  rule groups account-wide; they are AWS's, carry no data of any project and grant nothing on a web
  ACL.
- **Managed rule set references.** `WebAclsOfThisApp` also lists `<scope>/managedruleset/*/*`,
  because AWS WAF authorizes `CreateWebACL` and `UpdateWebACL` on every managed rule group the ACL
  references; the same call is still authorized on the web ACL ARN, fenced by the app's prefix.
- **Transcribe tagging on `*`.** `TagResource` with `aws:RequestTag/Project` could, in theory, tag
  a Transcribe resource of another project with this app's `Project`; it cannot remove or change
  that project's other tags (`aws:TagKeys` limits the keys) and grants nothing on it afterwards,
  because every later action is fenced by the `cuadrilla-poc-*` ARN.
- **Tag on create.** A service authorizes `TagResource` during a create call with the request tags
  only, which IAM cannot tell apart from tagging an existing untagged resource. A resource of
  another SST app carries its own `sst:app`, which the role cannot overwrite
  (`DenyRetaggingOtherApps`); an untagged resource of the listed services could be claimed.
  Closing that needs one account per project or an SCP.
- **Account-wide actions** with no resource-level permissions (CloudFront creates, `sst-asset-*`
  objects, listings, the Transcribe actions above), each justified next to its statement.
- A missing permission fails closed: the deploy stops with AccessDenied naming the action. The
  fix is a new statement with its justification, scoped by tag, name, IAM path or ARN, never a
  broader wildcard.
