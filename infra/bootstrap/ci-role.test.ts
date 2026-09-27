// Guards of the CI bootstrap (infra/bootstrap/ci-role.yaml) and of the deploy workflow. They read
// the files as text on purpose (the repository has no YAML parser and needs none): each check is a
// line someone under pressure would be tempted to write, and must not.
import { describe, expect, it } from "vitest";
import { policyEngineName } from "../policy-rules";
import { allows, block, deployWorkflow, parameterBlock, read, statement, statementsOf, template } from "./template-text";

const TRUSTS = {
  deploy: block(template, "  DeployRole:", "ManagedPolicyArns:"),
  "qa-runner": block(template, "  QaRunnerRole:", "      Policies:"),
};

describe.each(Object.entries(TRUSTS))("trust of the %s role", (_role, trust) => {

  it("matches the sub claim exactly, never with a wildcard", () => {
    expect(trust).toContain("StringEquals:");
    expect(trust).not.toMatch(/StringLike|ArnLike/);
    const subs = trust.split("\n").filter((line) => line.includes('"repo:'));
    expect(subs).toHaveLength(2);
    for (const sub of subs) {
      expect(sub).toContain(":ref:refs/heads/${DeployBranch}");
      expect(sub).not.toContain("*");
    }
  });

  it("accepts the id-bearing sub of repositories created after 2026-07-15", () => {
    expect(trust).toContain("repo:${GitHubOrg}@${GitHubOrgId}/${GitHubRepo}@${GitHubRepoId}:ref:refs/heads/${DeployBranch}");
  });

  it("binds the workflow file on the deploy branch", () => {
    expect(trust).toContain("token.actions.githubusercontent.com:job_workflow_ref:");
    expect(trust).toContain('/.github/workflows/deploy.yml@refs/heads/${DeployBranch}"');
  });

  it("always binds the immutable repository and owner ids", () => {
    expect(trust).toContain("token.actions.githubusercontent.com:repository_id: !Ref GitHubRepoId");
    expect(trust).toContain("token.actions.githubusercontent.com:repository_owner_id: !Ref GitHubOrgId");
    expect(trust).not.toContain("AWS::NoValue");
  });

});

describe("repository parameters", () => {
  it.each(["GitHubOrgId", "GitHubRepoId"])("makes %s mandatory and numeric", (parameter) => {
    const definition = parameterBlock(parameter);
    expect(definition).toContain('AllowedPattern: "^[0-9]+$"');
    expect(definition).not.toMatch(/^\s*Default:/m);
  });
});

describe("deploy workflow", () => {
  it("declares no environment, which would change the sub claim the trust expects", () => {
    expect(deployWorkflow).not.toMatch(/^\s*environment:/m);
  });

  it("assumes the role through OIDC and never with access keys", () => {
    expect(deployWorkflow).toContain("id-token: write");
    expect(deployWorkflow).toContain("role-to-assume:");
    expect(deployWorkflow).not.toMatch(/aws-access-key-id|aws-secret-access-key|AWS_SECRET_ACCESS_KEY/);
  });
});

describe("permissions of the deploy role and of the boundary", () => {
  it("defaults to the names of this app (docs/reuse-map.md, bootstrap row)", () => {
    for (const [name, value] of [
      ["AppName", "aws-cds-hackathon-poc-cuadrilla"],
      ["BucketPrefix", "aws-cds-hackathon-poc-cua"],
      ["DeployStage", "poc"],
      ["AppDomain", "cuadrilla.demo.craftech.io"],
      ["AgentNamePrefix", "aws_cds_hackathon_poc_cuadrilla"],
      ["GitHubOrg", "craftech-io"],
      ["GitHubRepo", "aws-cds-hackathon-poc-cuadrilla"],
    ] as const) {
      expect(parameterBlock(name), name).toContain(`Default: ${value}`);
    }
  });

  it("stays under the size CloudFormation accepts for an inline template body", () => {
    // `aws cloudformation deploy --template-file` needs an S3 bucket above 51,200 bytes; the
    // bootstrap must stay a single command with no prerequisites.
    expect(Buffer.byteLength(read("infra/bootstrap/ci-role.yaml"), "utf8")).toBeLessThan(51_200);
  });

  it("never opens the sst dev bridge: this app has no local stage", () => {
    expect(template).not.toContain("aws:PrincipalTag/sst:stage");
    expect(template).not.toContain("appsync:");
    const createRole = block(template, "Sid: IamCreateAppRolesWithBoundary", "- Sid: IamEditPoliciesOfBoundedAppRoles");
    expect(createRole).toContain("aws:RequestTag/sst:stage: !Ref DeployStage");
    expect(template).toContain("Sid: DenyRoleTagsOfOtherStages");
  });

  it("has no statement over every action", () => {
    expect(template).not.toMatch(/^\s*Action:\s*["']?\*["']?\s*$/m);
    expect(template).not.toMatch(/^\s*-\s*["']\*["']\s*$/m);
  });

  it("keeps the deploy role out of other projects' SST state", () => {
    expect(template).toContain("s3:::sst-state-*/*/${AppName}/*");
    expect(template).not.toMatch(/s3:::sst-state-\*\/\*"/);
  });

  it("fences IAM by the path of the app and forces the boundary on every new role", () => {
    const createRole = block(template, "Sid: IamCreateAppRolesWithBoundary", "- Sid: IamEditPoliciesOfBoundedAppRoles");
    expect(createRole).toContain("role/${AppName}/*");
    expect(createRole).toContain("iam:PermissionsBoundary: !Ref DeployBoundary");
    const outside = block(template, "Sid: DenyIamOutsideAppPath", "- Sid: DenyBoundaryRemovalOrSwap");
    expect(outside).toContain("NotResource:");
    for (const action of ["iam:UpdateAssumeRolePolicy", "iam:PassRole", "iam:AttachRolePolicy", "iam:PutRolePolicy", "sts:AssumeRole"]) {
      expect(outside).toContain(action);
    }
  });

  it("denies the administrative AWS managed policies", () => {
    const deny = block(template, "Sid: DenyAdministrativeManagedPolicies", "- Sid: DenyChangesToBootstrapResources");
    for (const policy of ["AdministratorAccess", "IAMFullAccess", "PowerUserAccess"]) {
      expect(deny).toContain(`policy/${policy}`);
    }
  });

  it("denies IAM management and role assumption to every role the app creates", () => {
    const boundary = block(template, "  DeployBoundary:", "  DeploySstHomePolicy:");
    const deny = block(boundary, "Sid: DenyIamManagementAndRoleAssumption", "- Sid: DenyPassingRolesOfOtherProjects");
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain("iam:Update*");
    expect(deny).toContain("sts:AssumeRole");
    expect(boundary).toContain("aws:ResourceTag/sst:app: !Ref AppName");
  });

  it("hands the Harness role the ECR Public bearer token and nothing else of STS", () => {
    const bearer = block(template, "Sid: HarnessImagePullBearerToken", "- Sid: HarnessRuntimeLogGroups");
    expect(bearer).toContain("sts:AWSServiceName: ecr-public.amazonaws.com");
    expect(template.split("\n").filter((line) => line.includes("sts:GetServiceBearerToken"))).toHaveLength(1);
  });

  it("creates SES identities and configuration sets only when the request tags them as the app", () => {
    const create = block(template, "Sid: CreateTaggedAsThisApp", "- Sid: NamedAppResources");
    expect(create).toContain("ses:CreateEmailIdentity");
    expect(create).toContain("ses:CreateConfigurationSet");
    expect(create).toContain("aws:RequestTag/sst:app: !Ref AppName");
    expect(create).toContain("bedrock:CreateKnowledgeBase");
    expect(template).not.toMatch(/contact-list|ContactList|sms-voice|states:|guardduty|appsync/);
  });

  it("has no SES receipt-rule action, rule set or inbound mail bucket: this app never receives email (ADR-0003)", () => {
    expect(template).not.toMatch(/ReceiptRule|receipt-rule|inbound-mail/);
  });

  it("fences the runtime under the Harness by the name AgentCore gives it", () => {
    const runtime = block(template, "Sid: HarnessUnderlyingRuntime", "- Sid: AgentCoreUntaggableChildren");
    expect(runtime).toContain("runtime/harness_${AgentNamePrefix}*");
    expect(runtime).not.toMatch(/bedrock-agentcore:\*/);
  });
});

describe("Cedar policies (names unique across every engine of the shared account)", () => {
  const PARAMETERS: Readonly<Record<string, string>> = {
    "AWS::Partition": "aws",
    "AWS::AccountId": "776805327629",
    Region: "us-east-1",
    AgentNamePrefix: /Default: (\S+)/.exec(parameterBlock("AgentNamePrefix"))?.[1] ?? "",
    DeployStage: /Default: (\S+)/.exec(parameterBlock("DeployStage"))?.[1] ?? "",
  };
  const engineArn = (id: string): string => `arn:aws:bedrock-agentcore:us-east-1:776805327629:policy-engine/${id}`;
  const OWN_ENGINE = engineArn(`${policyEngineName("aws-cds-hackathon-poc-cuadrilla", "poc")}-a1B2c3D4e5`);
  const OTHER_ENGINES = [engineArn("other_poc_app_poc-z9Y8x7W6v5"), engineArn("aws_cds_hackathon_poc_other_poc-z9Y8x7W6v5")];
  const POLICY_ACTION = /bedrock-agentcore:(\*|Create\*|CreatePolicy|DeletePolicy|GetPolicy|UpdatePolicy)$/m;
  const grants = allows.filter(({ body }) => POLICY_ACTION.test(body));
  /** The statement's ARN patterns with the template parameters substituted, as regular expressions. */
  const patterns = (body: string): RegExp[] =>
    [...body.matchAll(/!Sub "(arn:[^"]+)"/g)].map((match) => {
      const arn = (match[1] ?? "").replace(/\$\{([^}]+)\}/g, (_all, name: string) => PARAMETERS[name] ?? `\${${name}}`);
      return new RegExp(`^${arn.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    });
  const granted = (arn: string): boolean => grants.some(({ body }) => patterns(body).some((pattern) => pattern.test(arn)));

  it("grants the policy actions on Resource * only behind the app's tag", () => {
    expect(grants.length).toBeGreaterThan(0);
    for (const { sid, body } of grants.filter(({ body }) => body.includes('Resource: "*"'))) expect(body, sid).toMatch(/aws:(Resource|Request)Tag\/sst:app: !Ref AppName/);
  });

  it("creates, reads, updates and deletes policies of this app's engine, the engine ARN included", () => {
    expect(statement("CedarPoliciesOfThisAppsEngine")).toContain("policy-engine/${AgentNamePrefix}_${DeployStage}*");
    for (const arn of [OWN_ENGINE, `${OWN_ENGINE}/policy/cuadrilla_poc_CED_NO_OVERRIDE-q1W2e3R4t5`]) expect(granted(arn), arn).toBe(true);
  });

  it("never grants them on another app's engine or its policies", () => {
    expect(template).not.toContain("policy-engine/*");
    for (const engine of OTHER_ENGINES) for (const arn of [engine, `${engine}/policy/cuadrilla_poc_CED_NO_OVERRIDE-q1W2e3R4t5`]) expect(granted(arn), arn).toBe(false);
  });
});

const FUNCTION_FENCE = 'function/${AppName}-${DeployStage}-*"';
const KVS_FENCE = "!GetAtt RouterKeyValueStore.Arn";
const CACHE_POLICY_FENCE = 'cache-policy/${RouterCachePolicyId}"';

describe("CloudFront parts of the Router (no tags, shared account)", () => {
  it("grants cloudfront:* only behind the sst:app tag and the store data plane only on its ARN", () => {
    for (const { sid, body } of allows) {
      if (/cloudfront:\*/.test(body)) expect(body, sid).toContain("aws:ResourceTag/sst:app: !Ref AppName");
      if (body.includes("cloudfront-keyvaluestore:")) expect(body, sid).toContain(`Resource: ${KVS_FENCE}`);
    }
  });

  it("has no wildcard over the functions, stores or policies of the account", () => {
    expect(template).not.toMatch(
      /:cloudfront::\$\{AWS::AccountId\}:(function|key-value-store|cache-policy|origin-access-control|origin-request-policy|response-headers-policy)\/\*"/,
    );
  });

  it("updates, publishes and deletes only the functions named after this app", () => {
    for (const action of ["cloudfront:UpdateFunction", "cloudfront:PublishFunction", "cloudfront:DeleteFunction", "cloudfront:UntagResource"]) {
      for (const { sid, body } of allows.filter((candidate) => candidate.body.includes(action))) {
        expect(body, sid).toContain(`Resource: !Sub "arn:\${AWS::Partition}:cloudfront::\${AWS::AccountId}:${FUNCTION_FENCE}`);
      }
    }
    const deny = statement("DenyCloudFrontFunctionsOfOtherProjects");
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain(`NotResource: !Sub "arn:\${AWS::Partition}:cloudfront::\${AWS::AccountId}:${FUNCTION_FENCE}`);
    for (const action of ["cloudfront:UpdateFunction", "cloudfront:PublishFunction", "cloudfront:DeleteFunction"]) {
      expect(deny).toContain(action);
    }
  });

  it("reads and changes the tags of the functions named after this app by ARN (aws 7.33.0 tags them)", () => {
    const functions = statement("CloudFrontFunctionsOfThisApp");
    for (const action of ["cloudfront:ListTagsForResource", "cloudfront:TagResource", "cloudfront:UntagResource"]) {
      expect(functions).toContain(`- ${action}\n`);
    }
    expect(functions).toContain(`Resource: !Sub "arn:\${AWS::Partition}:cloudfront::\${AWS::AccountId}:${FUNCTION_FENCE}`);
    expect(functions).not.toContain("Condition:");
  });

  it("writes routes only into the store the bootstrap creates, and never creates or deletes a store", () => {
    expect(block(template, "  RouterKeyValueStore:", "  DeployBoundary:")).toContain("Type: AWS::CloudFront::KeyValueStore");
    const deny = statement("DenyKeyValueStoresOfOtherProjects");
    expect(deny).toContain("Action: cloudfront-keyvaluestore:*");
    expect(deny).toContain(`NotResource: ${KVS_FENCE}`);
    const notOwned = statement("DenyCloudFrontPartsTheAppDoesNotOwn");
    for (const action of ["CreateKeyValueStore", "DeleteKeyValueStore", "UpdateKeyValueStore"]) {
      expect(notOwned).toContain(`cloudfront:${action}`);
      expect(allows.filter(({ body }) => body.includes(`cloudfront:${action}`))).toHaveLength(0);
    }
  });

  it("changes a cache policy only by the id the operator declares, none by default", () => {
    const parameter = block(template, "  RouterCachePolicyId:", "Conditions:");
    expect(parameter).toContain("Default: none");
    expect(parameter).toContain('AllowedPattern: "^(none|[0-9a-f]{8}-');
    for (const action of ["cloudfront:UpdateCachePolicy", "cloudfront:DeleteCachePolicy"]) {
      for (const { sid, body } of allows.filter((candidate) => candidate.body.includes(action))) {
        expect(body, sid).toContain(CACHE_POLICY_FENCE);
      }
      expect(statement("DenyCachePoliciesOfOtherProjects")).toContain(action);
    }
    expect(statement("DenyCachePoliciesOfOtherProjects")).toContain(`NotResource: !Sub`);
  });

  it("never updates or deletes response headers, origin request policies or origin access controls", () => {
    const notOwned = statement("DenyCloudFrontPartsTheAppDoesNotOwn");
    for (const part of ["ResponseHeadersPolicy", "OriginRequestPolicy", "OriginAccessControl"]) {
      for (const verb of ["Update", "Delete"]) {
        expect(notOwned).toContain(`cloudfront:${verb}${part}`);
        expect(allows.filter(({ body }) => body.includes(`cloudfront:${verb}${part}`))).toHaveLength(0);
      }
    }
    expect(notOwned).toContain('Resource: "*"');
  });

  it("attaches the edge policy to the deploy role", () => {
    expect(block(template, "ManagedPolicyArns:", "Tags:")).toContain("- !Ref DeployEdgePolicy");
  });
});

describe("tags as the fence", () => {
  it("never lets a request tag move a resource of another app into this one", () => {
    const create = statement("CreateTaggedAsThisApp");
    const tagActions = [...create.matchAll(/- ([\w-]+:(?:TagResource|TagQueue|AddTagsToCertificate))/g)].map((match) => match[1]);
    expect(tagActions.length).toBeGreaterThan(10);
    const deny = statement("DenyRetaggingOtherApps");
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain("aws:ResourceTag/sst:app: !Ref AppName");
    expect(block(deny, "StringNotEquals:", '"Null":')).toContain("aws:ResourceTag/sst:app");
    expect(deny).toContain('aws:ResourceTag/sst:app: "false"');
    for (const action of tagActions) expect(deny).toContain(`- ${action}`);
  });

  it("fences SNS topics and SQS queues by the app name, the only fence before they exist", () => {
    // The provider reads a named topic before creating it, so a tag condition can never pass there.
    const named = statement("TopicsAndQueuesOfThisApp");
    expect(named).toContain('sns:${Region}:${AWS::AccountId}:${AppName}-*"');
    expect(named).toContain('sqs:${Region}:${AWS::AccountId}:${AppName}-*"');
    expect(named).toContain('sns:${Region}:${AWS::AccountId}:${AppName}-wa-inbound"');
    expect(named).not.toMatch(/Resource: "\*"/);
    for (const action of ["sns:*", "sqs:*", "sns:Publish", "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:PurgeQueue"]) expect(named).not.toContain(`- ${action}\n`);
    expect(block(template, "ManagedPolicyArns:", "Tags:")).toContain("- !Ref DeployNamedResourcesPolicy");
  });

  it("reads log group tags account-wide but writes none of them outside the tag fence", () => {
    const reads = statement("LogGroupTagReads");
    expect(reads).toContain("- logs:ListTagsForResource");
    expect(reads).toContain("- logs:ListTagsLogGroup");
    expect(reads.match(/- logs:/g)).toHaveLength(2);
    expect(reads).not.toContain("logs:*");
  });

  it("grants the Cloud Control API under its real IAM prefix, limited to the region", () => {
    // `awsnative.*` resources go through Cloud Control, whose actions are `cloudformation:*Resource*`;
    // a `cloudcontrol:` action grants nothing and the deploy stops with AccessDenied.
    expect(template).not.toMatch(/-\s+cloudcontrol:/);
    const transport = statement("CloudControlTransport");
    for (const action of ["CreateResource", "GetResource", "UpdateResource", "DeleteResource", "GetResourceRequestStatus"]) {
      expect(transport).toContain(`- cloudformation:${action}`);
    }
    expect(transport).toContain("aws:RequestedRegion: !Ref Region");
    expect(transport).not.toContain("cloudformation:*");
    // The request log is account-wide: listing or cancelling would reach every project.
    for (const action of ["ListResources", "ListResourceRequests", "CancelResourceRequest"]) expect(transport).not.toContain(`cloudformation:${action}`);
  });

  it("keeps every managed policy under IAM's 6,144-character limit", () => {
    // IAM counts the rendered JSON without whitespace; !Sub expansion and JSON quoting add up to
    // ~14% over the YAML, so the YAML budget keeps a 20% margin.
    const names = ["DeployBoundary", "DeploySstHomePolicy", "DeployAppResourcesPolicy", "DeployNamedResourcesPolicy", "DeployEdgePolicy", "DeployDnsAndIamPolicy", "DeployRole"];
    expect(names.slice(0, -1).every((name) => template.includes(`  ${name}:\n    Type: AWS::IAM::ManagedPolicy`))).toBe(true);
    for (const [name, next] of names.slice(0, -1).map((name, index) => [name, names[index + 1] ?? ""] as const)) {
      const document = block(block(template, `  ${name}:`, `  ${next}:`), "PolicyDocument:", "\n\n");
      expect(document.replace(/\s/g, "").length * 1.2, name).toBeLessThan(6_144);
    }
  });
});

const boundary = block(template, "  DeployBoundary:", "  DeploySstHomePolicy:");
const deployPolicies = block(template, "  DeploySstHomePolicy:", "  DeployRole:");

describe("own sign-up, leads and AWS WAF (ADR-0025, ADR-0026) [FL-114]", () => {
  const WEB_ACLS = ['wafv2:${Region}:${AWS::AccountId}:global/webacl/${AppName}-*"', 'wafv2:${Region}:${AWS::AccountId}:regional/webacl/${AppName}-*"'];

  it("manages web ACLs only by the app's name prefix, in both scopes, and never wafv2:*", () => {
    const acls = statement("WebAclsOfThisApp");
    for (const arn of WEB_ACLS) expect(acls).toContain(arn);
    for (const action of ["CreateWebACL", "UpdateWebACL", "DeleteWebACL", "GetWebACL", "AssociateWebACL", "DisassociateWebACL", "TagResource"]) expect(acls).toContain(`- wafv2:${action}\n`);
    expect(acls).not.toContain('Resource: "*"');
    expect(template).not.toMatch(/wafv2:\*|webacl\/\*/);
    for (const { sid, body } of allows.filter(({ body }) => /- wafv2:(Create|Update|Delete|Associate|Disassociate|Tag|Untag)/.test(body))) for (const arn of WEB_ACLS) expect(body, sid).toContain(arn);
  });

  it("reads AWS's managed rule groups and never creates an API key of AWS WAF (no CAPTCHA)", () => {
    const reads = statement("ManagedRuleGroupReads");
    expect([...reads.matchAll(/- (wafv2:\w+)/g)].map((match) => match[1]).sort()).toEqual(["wafv2:CheckCapacity", "wafv2:DescribeManagedRuleGroup", "wafv2:ListAvailableManagedRuleGroupVersions", "wafv2:ListAvailableManagedRuleGroups"]);
    expect(template).not.toMatch(/APIKey|captcha/i);
  });

  it("associates a web ACL only with a Cognito pool tagged as this app", () => {
    const association = statement("CognitoWebAclAssociation");
    for (const action of ["AssociateWebACL", "DisassociateWebACL", "GetWebACLForResource"]) expect(association).toContain(`- cognito-idp:${action}`);
    expect(association).toContain("aws:ResourceTag/sst:app: !Ref AppName");
  });

  it("maps event sources only onto functions named after the app", () => {
    const mappings = statement("EventSourceMappingsOfThisApp");
    for (const action of ["CreateEventSourceMapping", "UpdateEventSourceMapping", "DeleteEventSourceMapping"]) expect(mappings).toContain(`- lambda:${action}`);
    expect(mappings).toContain('lambda:FunctionArn: !Sub "arn:${AWS::Partition}:lambda:${Region}:${AWS::AccountId}:function:${AppName}-*"');
    expect(mappings).toContain("ArnLike:");
  });

  it("adds event destinations (CloudWatch by kind) only to the app's configuration set", () => {
    const destinations = statement("SesEventDestinationsOfThisApp");
    expect(destinations).toContain("- ses:CreateConfigurationSetEventDestination");
    expect(destinations).toContain('configuration-set/${AppName}-email-${DeployStage}"');
    expect(destinations).not.toContain('Resource: "*"');
  });

  it("lets app roles read only the app's web ACLs and invoke the account deletion by its name", () => {
    const reads = block(boundary, "Sid: WebAclReadsOfThisApp", "- Sid:");
    expect([...reads.matchAll(/- (wafv2:\w+)/g)].map((match) => match[1])).toEqual(["wafv2:GetWebACL", "wafv2:GetWebACLForResource"]);
    for (const arn of WEB_ACLS) expect(reads).toContain(arn);
    expect(block(boundary, "Sid: InvokeAccountDeletionByName", "- Sid:")).toContain("function:${AppName}-${DeployStage}-guest-account-deletion");
  });

  it("creates the origin request policy of /api/* and lets the deploy role only read it", () => {
    expect(template).toContain("Type: AWS::CloudFront::OriginRequestPolicy");
    expect(statement("CloudFrontCreatesAndReads")).toContain("- cloudfront:GetOriginRequestPolicy");
    for (const verb of ["Create", "Update", "Delete"]) expect(allows.filter(({ body }) => body.includes(`cloudfront:${verb}OriginRequestPolicy`))).toHaveLength(0);
    expect(read("infra/bootstrap/ci-role.yaml")).toContain("ApiOriginRequestPolicyId:");
  });

  it("creates the cache policy of /api/* and lets the deploy role only read it (update and delete stay on RouterCachePolicyId)", () => {
    for (const text of ["Type: AWS::CloudFront::CachePolicy", "ApiCachePolicyId:"]) expect(template).toContain(text);
    for (const action of ["cloudfront:GetCachePolicy", "cloudfront:ListCachePolicies"]) expect(statement("CloudFrontCreatesAndReads")).toContain(`- ${action}`);
    expect(statement("DenyCachePoliciesOfOtherProjects")).toContain("cache-policy/${RouterCachePolicyId}");
  });

  it("keeps the Leads table and its stream inside the app's table fence", () => {
    for (const policy of [boundary, deployPolicies]) {
      const named = statementsOf(policy).filter(({ body }) => body.includes("- dynamodb:*"));
      expect(named).toHaveLength(1);
      expect(named[0]?.body).toContain('table/${AppName}-*"');
    }
  });
});
