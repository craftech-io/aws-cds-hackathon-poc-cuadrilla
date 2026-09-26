// IAM of the agent (docs/architecture.md §14, rows "Harness (ejecución)", "Memory (ejecución)" and "Gateway",
// docs/build-plan.md WP-26): three roles assumed by `bedrock-agentcore.amazonaws.com`, each with one inline
// policy. Their statements are pure functions (checked by infra/agentcore-spec.test.ts); the roles are created
// on the first `agentRoles()` call, by infra/agent-tools.ts or infra/agentcore.ts, whichever runs first.
//
//   <app>-<stage>-harness  the Harness execution role: exactly SERVICE_ROLES.Harness of
//                          infra/iam-capabilities.ts (the model through agentModelArns(HARNESS_MODEL_ID), G1,
//                          InvokeGateway, the Memory events and retrieval) plus what its runtime needs to run:
//                          workload identity, its own runtime log groups, X-Ray, the `bedrock-agentcore`
//                          metrics and the pull of the managed image (the "logs del runtime, X-Ray" of §14).
//   <app>-<stage>-gateway  lambda:InvokeFunction on the five target Lambdas (SERVICE_ROLES.Gateway) plus the
//                          three policy engine actions the Gateway needs to evaluate Cedar (without them every
//                          tool call is denied).
//   <app>-<stage>-memory   the extraction model of the three strategy overrides, sid `ExtractionModel`
//                          (SERVICE_ROLES.Memory): a strategy with a prompt override needs a memory role.
//
// Names are fixed because Cedar names the Harness by `assumed-role/<name>` (infra/policy.ts) and
// `iam get-role-policy` needs them. The path `/<app>/` and the permissions boundary come from the $transform
// of infra/ci.ts; nothing here sets them. Every action lies inside the boundary of infra/bootstrap/ci-role.yaml
// (the test holds it): `*` only where the action has no resource-level permission (AGENT_ROLE_WILDCARD_SIDS).
//
// Trust: `aws:SourceAccount` always, and `aws:SourceArn`: the Memory of this stage (`memory/<name>-*`, its id
// is the name plus a suffix, known before the Memory exists), the Gateways of this stage (`gateway/<name>-*`)
// and, for the Harness, the AgentCore resources of this account (its assume-role source, harness or the runtime
// under it, is not documented precisely enough to narrow further).
//
// Verify:
//   aws --profile craftech-demos iam get-role-policy --role-name aws-cds-hackathon-poc-cuadrilla-poc-harness --policy-name <name>
//   aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-cuadrilla-poc-memory
//     → Path /aws-cds-hackathon-poc-cuadrilla/, PermissionsBoundary …-ci-boundary, trust with the memory ARN pattern

import { agentRoleName, gatewayName, harnessName, HARNESS_MODEL_ID, memoryName, RUNTIME_LOG_GROUP_PREFIX } from "./agentcore-spec";
import { SERVICE_ROLES, agentModelArns, type Grant } from "./iam-capabilities";

/** Account and region the ARNs are built for (the resources read them from the provider). */
export interface AgentPlace {
  readonly account: string;
  readonly region: string;
}

export interface AgentStatement {
  readonly sid: string;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  readonly condition?: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>;
}

export type AgentRole = "Harness" | "Gateway" | "Memory";

export const AGENT_ROLE_PURPOSE = { Harness: "harness", Gateway: "gateway", Memory: "memory" } as const satisfies Record<AgentRole, string>;

export const AGENTCORE_PRINCIPAL = "bedrock-agentcore.amazonaws.com";

/** Statements whose resource is `*`: their actions have no resource-level permission. */
export const AGENT_ROLE_WILDCARD_SIDS = ["Traces", "Metrics", "ManagedImagePull", "ManagedImageBearer"] as const;

/**
 * ARNs each placeholder of SERVICE_ROLES stands for (`{G1}`, `{Gateway}`, `{Memory}`, `{ToolOrders}`, …) plus
 * `{PolicyEngine}` for the Gateway's Cedar actions; `{model:HARNESS}` is resolved here.
 */
export type AgentRefs = Readonly<Record<string, readonly string[]>>;

const SID_BY_REF: Readonly<Record<string, string>> = {
  "{model:HARNESS}": "Model",
  "{G1}": "GuardrailG1",
  "{Gateway}": "Gateway",
  "{Memory}": "Memory",
  "{ToolOrders}": "InvokeToolTargets",
};

export const agentCoreArnPrefix = (place: AgentPlace): string => `arn:aws:bedrock-agentcore:${place.region}:${place.account}`;

/** The source of the assume-role each role accepts (header). */
export function trustSourcePattern(role: AgentRole, place: AgentPlace, app: string, stage: string): string {
  switch (role) {
    case "Memory":
      return `${agentCoreArnPrefix(place)}:memory/${memoryName(app, stage)}-*`;
    case "Gateway":
      return `${agentCoreArnPrefix(place)}:gateway/${gatewayName(app, stage).toLowerCase()}-*`;
    case "Harness":
      return `${agentCoreArnPrefix(place)}:*`;
  }
}

/** Trust of an agent role: AgentCore only, this account only, from `sourceArnPattern` only (confused deputy). */
export function agentCoreTrustPolicy(place: AgentPlace, sourceArnPattern: string): string {
  const condition = { StringEquals: { "aws:SourceAccount": place.account }, ArnLike: { "aws:SourceArn": sourceArnPattern } };
  return JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: AGENTCORE_PRINCIPAL }, Action: "sts:AssumeRole", Condition: condition }] });
}

function resolveRef(ref: string, refs: AgentRefs, place: AgentPlace): readonly string[] {
  if (ref === "{model:HARNESS}") return agentModelArns(HARNESS_MODEL_ID, place.region, place.account);
  const resolved = refs[ref];
  if (resolved === undefined || resolved.length === 0) throw new Error(`The IAM of the agent needs the ARN of ${ref}.`);
  return resolved;
}

function capabilityStatement(grant: Grant, refs: AgentRefs, place: AgentPlace): AgentStatement {
  const sid = grant.sid ?? SID_BY_REF[grant.resources[0] ?? ""];
  if (sid === undefined) throw new Error(`No statement id for the agent grant on ${grant.resources.join(", ")}.`);
  const condition = grant.conditions?.reduce<Record<string, Record<string, readonly string[]>>>((all, entry) => {
    all[entry.test] = { ...all[entry.test], [entry.variable]: entry.values };
    return all;
  }, {});
  return { sid, actions: grant.actions, resources: grant.resources.flatMap((ref) => resolveRef(ref, refs, place)), ...(condition ? { condition } : {}) };
}

/** Exactly the grants of SERVICE_ROLES in infra/iam-capabilities.ts, with their placeholders resolved. */
export function capabilityStatements(role: AgentRole, refs: AgentRefs, place: AgentPlace): AgentStatement[] {
  const grants: readonly Grant[] = SERVICE_ROLES[role].grants;
  return grants.map((grant) => capabilityStatement(grant, refs, place));
}

/** What the Harness runtime itself needs to run (header); each `*` is one of AGENT_ROLE_WILDCARD_SIDS. */
export function harnessRuntimeStatements(place: AgentPlace, app: string, stage: string): AgentStatement[] {
  const runtime = `harness_${harnessName(app, stage)}`;
  const logGroups = `arn:aws:logs:${place.region}:${place.account}:log-group:${RUNTIME_LOG_GROUP_PREFIX}${runtime}*`;
  const identity = `${agentCoreArnPrefix(place)}:workload-identity-directory/default`;
  return [
    { sid: "WorkloadIdentity", actions: ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"], resources: [identity, `${identity}/workload-identity/${runtime}-*`] },
    { sid: "RuntimeLogGroup", actions: ["logs:CreateLogGroup", "logs:DescribeLogStreams"], resources: [logGroups] },
    { sid: "RuntimeLogStreams", actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [`${logGroups}:log-stream:*`] },
    { sid: "DescribeLogGroups", actions: ["logs:DescribeLogGroups"], resources: [`arn:aws:logs:${place.region}:${place.account}:log-group:*`] },
    { sid: "Traces", actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"], resources: ["*"] },
    { sid: "Metrics", actions: ["cloudwatch:PutMetricData"], resources: ["*"], condition: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } } },
    { sid: "ManagedImagePull", actions: ["ecr-public:GetAuthorizationToken"], resources: ["*"] },
    { sid: "ManagedImageBearer", actions: ["sts:GetServiceBearerToken"], resources: ["*"], condition: { StringEquals: { "sts:AWSServiceName": "ecr-public.amazonaws.com" } } },
  ];
}

/** What the Gateway needs to evaluate Cedar on this stage's engine (infra/policy.ts). */
export function gatewayRuntimeStatements(refs: AgentRefs, place: AgentPlace, app: string, stage: string): AgentStatement[] {
  const engine = resolveRef("{PolicyEngine}", refs, place);
  return [
    { sid: "PolicyEngineConfiguration", actions: ["bedrock-agentcore:GetPolicyEngine"], resources: engine },
    { sid: "PolicyEngineAuthorization", actions: ["bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"], resources: [...engine, trustSourcePattern("Gateway", place, app, stage)] },
  ];
}

/** Every statement of one agent role: its capabilities first, then what its runtime needs. */
export function agentRoleStatements(role: AgentRole, refs: AgentRefs, place: AgentPlace, app: string, stage: string): AgentStatement[] {
  const runtime = role === "Harness" ? harnessRuntimeStatements(place, app, stage) : role === "Gateway" ? gatewayRuntimeStatements(refs, place, app, stage) : [];
  return [...capabilityStatements(role, refs, place), ...runtime];
}

export function policyDocument(statements: readonly AgentStatement[]): string {
  const rendered = statements.map(({ sid, actions, resources, condition }) => ({ Sid: sid, Effect: "Allow", Action: [...actions], Resource: [...resources], ...(condition ? { Condition: condition } : {}) }));
  return JSON.stringify({ Version: "2012-10-17", Statement: rendered });
}

// ---- Resources (created on the first call, inside the SST program) ----------------------------------------

export type AgentRoles = Readonly<Record<AgentRole, aws.iam.Role>>;

const ROLE_DESCRIPTIONS: Readonly<Record<AgentRole, string>> = {
  Harness: "Execution role of the AgentCore Harness: model, G1, Gateway, Memory, runtime logs and traces.",
  Gateway: "Assumed by the AgentCore Gateway: invokes the five tool Lambdas and evaluates Cedar.",
  Memory: "Assumed by AgentCore Memory to run the extraction model of its three strategy overrides.",
};

let place: $util.Output<AgentPlace> | undefined;
let roles: AgentRoles | undefined;

/** Account and region of the provider, the scope of every ARN of the agent's policies. */
export function agentPlace(): $util.Output<AgentPlace> {
  place ??= $util.all([aws.getCallerIdentityOutput({}).accountId, aws.getRegionOutput({}).region]).apply(([account, region]) => ({ account, region }));
  return place;
}

/** The three roles, created once; their policies come from `agentRolePolicy`, scoped to what infra/agentcore.ts creates. */
export function agentRoles(): AgentRoles {
  roles ??= Object.fromEntries(
    (Object.keys(AGENT_ROLE_PURPOSE) as AgentRole[]).map((role) => [
      role,
      new aws.iam.Role(`Agent${role}Role`, {
        name: agentRoleName($app.name, $app.stage, AGENT_ROLE_PURPOSE[role]),
        description: ROLE_DESCRIPTIONS[role],
        assumeRolePolicy: agentPlace().apply((resolved) => agentCoreTrustPolicy(resolved, trustSourcePattern(role, resolved, $app.name, $app.stage))),
      }),
    ]),
  ) as Record<AgentRole, aws.iam.Role>;
  return roles;
}

/** The one inline policy of an agent role, with each placeholder resolved to the ARNs of `refs`. */
export function agentRolePolicy(role: AgentRole, refs: Readonly<Record<string, $util.Input<string[]>>>): aws.iam.RolePolicy {
  const entries = Object.entries(refs);
  return new aws.iam.RolePolicy(`Agent${role}RolePolicy`, {
    role: agentRoles()[role].id,
    policy: $util
      .all([agentPlace(), $util.all(entries.map(([, arns]) => $util.output(arns)))])
      .apply(([resolved, arns]) => {
        const refsResolved: AgentRefs = Object.fromEntries(entries.map(([ref], index) => [ref, arns[index] ?? []]));
        return policyDocument(agentRoleStatements(role, refsResolved, resolved, $app.name, $app.stage));
      }),
  });
}
