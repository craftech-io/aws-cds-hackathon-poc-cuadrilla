// Bedrock AgentCore: the agent as resources (docs/architecture.md §4, §9 and §12, docs/design-brief.md §5.3-§5.6,
// ADR-0014, ADR-0020, docs/build-plan.md WP-26). Names, limits, strategies and verified service facts:
// infra/agentcore-spec.ts; roles: infra/agentcore-iam.ts; tool Lambdas: infra/agent-tools.ts; schemas:
// infra/agent-tool-schemas.ts; Cedar: infra/policy.ts; G4: infra/guardrail.ts.
//
//   Memory      `aws_cds_hackathon_poc_cuadrilla_poc`, events 30 days, three custom strategies with the same
//               exclusion rules: `installerTips` (semantic override), `installerPreferences` (userPreference
//               override) and `workOrderSummary` (summary override), all per installer actor
//               (`inst-<installerId>-e<worldEpoch>`, passed by the worker on every invocation), run by the
//               memory role with the extraction model HARNESS_MODEL_ID through the app's inference profile.
//   Profile     `<app>-<stage>-sonnet-5-5` (infra/agentcore-iam.ts `agentModelProfile()`, ADR-0028): a tagged
//               copy of the global profile of HARNESS_MODEL_ID; the Harness, Memory and PhotoModel call its ARN.
//               After a model change the Memory update may fail once on IAM propagation: rerun the CI job
//               (docs/architecture.md §16), never a local deploy.
//   Gateway     `aws-cds-hackathon-poc-cuadrilla-poc`, MCP, `AWS_IAM`, called only by the Harness role; the
//               policy engine of infra/policy.ts in ENFORCE.
//   Targets     orders, knowledge, evidence, messaging, cases: Lambda + inline schema, created ONE AT A TIME
//               (Cloud Control rejects concurrent target writes on a gateway) through a dependsOn chain, with
//               ignoreChanges (GATEWAY_SCHEMA_ROLLOUT says how a schema change ships).
//   Policies    the Cedar statements CED-* of WP-08, attached after the LAST target: the engine validates each
//               statement against the Gateway's tool schemas.
//   Harness     HARNESS_MODEL_ID (the profile's ARN) over converse_stream with G4 in the model parameters; maxIterations 10,
//               maxTokens 4096, timeout 90 s, sliding window 40; tools = the Gateway only
//               (`@cuadrilla-tools/*`), so no shell, file or code tools; the static system prompt of
//               packages/bff/src/agent/system-prompt.ts; public network, idle microVMs stopped after 5
//               minutes. Created after the policies, so no turn ever runs without the fences. No `effort`:
//               the Harness does not expose it (HARNESS_EFFORT).
//   Log group   `/aws/bedrock-agentcore/runtimes/<runtimeId>-live`, 30 days, created after the Harness and
//               before the endpoint. The DEFAULT one AgentCore creates gets its 30 days as declared manual
//               configuration (DEFAULT_RUNTIME_LOG_RETENTION of infra/agentcore-spec.ts, docs/architecture.md
//               §17 item 15). Content capture in traces cannot be turned off: TRACE_CONTENT_CAPTURE.
//   Endpoint    `live`, pinned to the Harness version of this deploy.
//
// What code links:
//   Harness   `Resource.Harness.{harnessArn, endpointName, …}` and InvokeHarness on the harness, its endpoint and
//             the runtime under it: InstallerWorker only (infra/workers.ts, late link), the only holder of a
//             grant on `{Harness}` in infra/iam-capabilities.ts.
//   Memory    `Resource.Memory.{memoryId, …}` and MEMORY_ADMIN on this Memory: the WORLDS roles (WorldJanitor,
//             Bff, QaDriver) for the purge and `memory.inspect`.
//
// Cost: per model token, Gateway call, policy evaluation, Memory event and record; nothing bills while idle.
//
// Verify (AWS CLI ≥ 2.27, or the SDK v3 scripts, docs/architecture.md §16):
//   aws --profile craftech-demos bedrock-agentcore-control list-harnesses                                  → READY
//   aws --profile craftech-demos bedrock-agentcore-control list-harness-endpoints --harness-id <id>         → live READY
//   aws --profile craftech-demos bedrock-agentcore-control list-gateway-targets --gateway-identifier <id>  → 5 READY
//   aws --profile craftech-demos bedrock-agentcore-control get-memory --memory-id <id>                     → ACTIVE, 3 strategies
//   aws --profile craftech-demos logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/harness_aws_cds_hackathon_poc_cuadrilla_poc
//     → <runtimeId>-live and <runtimeId>-DEFAULT with retentionInDays 30
//   aws --profile craftech-demos bedrock get-inference-profile --inference-profile-identifier aws-cds-hackathon-poc-cuadrilla-poc-sonnet-5-5
//     → ACTIVE, models of global.anthropic.claude-sonnet-5-5, tags Project/Stage/ManagedBy/Owner

import { SYSTEM_PROMPT } from "../packages/bff/src/agent/system-prompt";
import { gatewayToolSchemas } from "./agent-tool-schemas";
import { gatewayInvokePermissions, toolFunctions } from "./agent-tools";
import { agentModelProfile, agentRolePolicy, agentRoles } from "./agentcore-iam";
import {
  AGENT_LOG_RETENTION_DAYS,
  GATEWAY_TOOL_NAME,
  HARNESS_ALLOWED_TOOLS,
  HARNESS_ENDPOINT_NAME,
  HARNESS_LIFECYCLE,
  HARNESS_LIMITS,
  HARNESS_LINK,
  HARNESS_MODEL_ID,
  MEMORY_EVENT_EXPIRY_DAYS,
  MEMORY_LINK,
  MEMORY_REF,
  MEMORY_STRATEGIES,
  TOOL_FUNCTIONS,
  gatewayName,
  gatewayTargetDescription,
  gatewayTargetIgnoreChanges,
  harnessBedrockModelConfig,
  harnessInvokeActions,
  harnessName,
  memoryName,
  memoryRetrievalConfig,
  memoryStrategyArgs,
  runtimeLogGroupEndpoints,
  runtimeLogGroupName,
  schemaDigest,
  textDigest,
} from "./agentcore-spec";
import { guardrailArns, harnessGuardrailConfig } from "./guardrail";
import { CAPABILITIES } from "./iam-capabilities";
import { GATEWAY_POLICY_ENGINE_MODE, attachGatewayPolicies, policyEngineArn } from "./policy";
import { GATEWAY_TARGETS, type GatewayTarget } from "./policy-rules";
import { tagList, tagMap } from "./tags";

const pascal = (value: string): string => `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()}`;
const one = (arn: $util.Input<string>): $util.Output<string[]> => $util.output(arn).apply((value) => [value]);
const roles = agentRoles();
/** The app's inference profile (ADR-0028): the model the Harness and the three strategies call. */
const modelProfile = agentModelProfile();
const modelRefs = { "{model:PROFILE}": one(modelProfile.arn) };

// ---- Memory ------------------------------------------------------------------------------------------

const memoryRolePolicy = agentRolePolicy("Memory", modelRefs);

export const memory = new awsnative.bedrockagentcore.Memory(
  "AgentMemory",
  {
    name: memoryName($app.name, $app.stage),
    description: `Installer tips, preferences and work order summaries of the ${$app.name} agent, stage ${$app.stage}.`,
    eventExpiryDuration: MEMORY_EVENT_EXPIRY_DAYS,
    memoryExecutionRoleArn: roles.Memory.arn,
    memoryStrategies: modelProfile.arn.apply(memoryStrategyArgs),
    tags: tagMap(),
  },
  // The strategies with overrides run the extraction model with this role from the first event.
  { dependsOn: [memoryRolePolicy] },
);

// ---- Gateway and its targets -------------------------------------------------------------------------

const gatewayRolePolicy = agentRolePolicy("Gateway", {
  ...Object.fromEntries(GATEWAY_TARGETS.map((target) => [`{${TOOL_FUNCTIONS[target]}}`, one(toolFunctions[target].arn)])),
  "{PolicyEngine}": one(policyEngineArn),
});

export const gateway = new awsnative.bedrockagentcore.Gateway(
  "AgentGateway",
  {
    name: gatewayName($app.name, $app.stage),
    description: `MCP tools of the ${$app.name} agent (${$app.stage}); called only by the Harness execution role.`,
    authorizerType: "AWS_IAM",
    protocolType: "MCP",
    roleArn: roles.Gateway.arn,
    policyEngineConfiguration: { arn: policyEngineArn, mode: GATEWAY_POLICY_ENGINE_MODE },
    tags: tagMap(),
  },
  // The Gateway evaluates Cedar and invokes the targets with its role: without the policy the first call fails.
  { dependsOn: [gatewayRolePolicy] },
);

const targets = {} as Record<GatewayTarget, awsnative.bedrockagentcore.GatewayTarget>;
// The first target waits for both sides of invoking the Lambdas: the role's policy and each target's resource policy.
let previous: $util.Resource[] = [gatewayRolePolicy, ...Object.values(gatewayInvokePermissions)];

for (const target of GATEWAY_TARGETS) {
  const { inlinePayload } = gatewayToolSchemas[target];
  targets[target] = new awsnative.bedrockagentcore.GatewayTarget(
    `AgentGatewayTarget${pascal(target)}`,
    {
      gatewayIdentifier: gateway.gatewayIdentifier,
      // Cedar action ids are `<name>___<tool>` (infra/policy-rules.ts): the name is the target id.
      name: target,
      description: gatewayTargetDescription(target, inlinePayload.length, schemaDigest(inlinePayload)),
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      targetConfiguration: { mcp: { lambda: { lambdaArn: toolFunctions[target].arn, toolSchema: { inlinePayload } } } },
    },
    { dependsOn: previous, ignoreChanges: gatewayTargetIgnoreChanges(target) },
  );
  previous = [targets[target]];
}

export const gatewayTargets: Readonly<Record<GatewayTarget, awsnative.bedrockagentcore.GatewayTarget>> = targets;

/** Cedar of WP-08, after the last target: permits first, then the forbids (infra/policy.ts). */
export const gatewayPolicies = attachGatewayPolicies({
  gatewayArn: gateway.gatewayArn,
  harnessRoleName: roles.Harness.name,
  targetNames: GATEWAY_TARGETS,
  toolSchemas: Object.fromEntries(GATEWAY_TARGETS.map((target) => [target, gatewayToolSchemas[target].inlinePayload])) as Record<GatewayTarget, (typeof gatewayToolSchemas)[GatewayTarget]["inlinePayload"]>,
  dependsOn: previous,
});

// ---- Harness, its runtime log group and the endpoint --------------------------------------------------

const harnessRolePolicy = agentRolePolicy("Harness", {
  ...modelRefs,
  "{G4}": one(guardrailArns.g4),
  "{Gateway}": one(gateway.gatewayArn),
  [MEMORY_REF]: one(memory.memoryArn),
});

export const harness = new awsnative.bedrockagentcore.Harness(
  "AgentHarness",
  {
    harnessName: harnessName($app.name, $app.stage),
    executionRoleArn: roles.Harness.arn,
    // G4 on every model call (infra/guardrail.ts); nothing sends a model, a system prompt or tools from the edge.
    model: { bedrockModelConfig: harnessBedrockModelConfig(modelProfile.arn, harnessGuardrailConfig) },
    systemPrompt: [{ text: SYSTEM_PROMPT }],
    environment: {
      agentCoreRuntimeEnvironment: {
        networkConfiguration: { networkMode: "PUBLIC" },
        lifecycleConfiguration: {
          idleRuntimeSessionTimeout: HARNESS_LIFECYCLE.idleRuntimeSessionTimeoutSeconds,
          maxLifetime: HARNESS_LIFECYCLE.maxLifetimeSeconds,
        },
      },
    },
    tools: [
      {
        type: "agentcore_gateway",
        name: GATEWAY_TOOL_NAME,
        config: { agentCoreGateway: { gatewayArn: gateway.gatewayArn, outboundAuth: { awsIam: {} } } },
      },
    ],
    allowedTools: [...HARNESS_ALLOWED_TOOLS],
    maxIterations: HARNESS_LIMITS.maxIterations,
    maxTokens: HARNESS_LIMITS.maxTokens,
    timeoutSeconds: HARNESS_LIMITS.timeoutSeconds,
    truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: HARNESS_LIMITS.slidingWindowMessages } } },
    memory: { agentCoreMemoryConfiguration: { arn: memory.memoryArn, retrievalConfig: memoryRetrievalConfig() } },
    tags: tagList({ SystemPromptDigest: textDigest(SYSTEM_PROMPT) }),
  },
  { dependsOn: [harnessRolePolicy, ...Object.values(gatewayPolicies)] },
);

/** The AgentCore Runtime under the Harness: its id names the runtime log groups. */
const runtime = harness.environment.apply((environment) => {
  const { agentRuntimeId: id, agentRuntimeArn: arn } = environment?.agentCoreRuntimeEnvironment ?? {};
  if (id === undefined || id === "") {
    throw new Error("The Harness state has no environment.agentCoreRuntimeEnvironment.agentRuntimeId, so the log group of the live endpoint cannot be named before it.");
  }
  return { id, arn };
});

/** Created before the endpoint, so AgentCore never creates it first (with no retention). */
export const harnessLogGroups: aws.cloudwatch.LogGroup[] = runtimeLogGroupEndpoints(HARNESS_ENDPOINT_NAME).map(
  (endpoint) =>
    new aws.cloudwatch.LogGroup(`HarnessRuntimeLogs${pascal(endpoint)}`, {
      name: runtime.apply(({ id }) => runtimeLogGroupName(id, endpoint)),
      retentionInDays: AGENT_LOG_RETENTION_DAYS,
    }),
);

export const harnessEndpoint = new awsnative.bedrockagentcore.HarnessEndpoint(
  "AgentHarnessEndpoint",
  {
    harnessId: harness.harnessId,
    endpointName: HARNESS_ENDPOINT_NAME,
    description: `Endpoint the installer worker invokes; follows the Harness version of each deploy (${$app.stage}).`,
    targetVersion: harness.version,
    tags: tagList(),
  },
  { dependsOn: harnessLogGroups },
);

// ---- Links -------------------------------------------------------------------------------------------

/**
 * InstallerWorker (infra/workers.ts, late link): the grants on `{Harness}` of infra/iam-capabilities.ts, on the
 * harness, the `live` endpoint it names and the runtime under it (the Harness's resources, whatever action the
 * table grants on them).
 */
export const Harness = new sst.Linkable(HARNESS_LINK, {
  properties: {
    harnessArn: harness.arn,
    harnessId: harness.harnessId,
    endpointName: HARNESS_ENDPOINT_NAME,
    endpointArn: harnessEndpoint.arn,
    modelId: HARNESS_MODEL_ID,
    modelProfileArn: modelProfile.arn,
    timeoutSeconds: HARNESS_LIMITS.timeoutSeconds,
    maxIterations: HARNESS_LIMITS.maxIterations,
    maxTokens: HARNESS_LIMITS.maxTokens,
  },
  include: [
    sst.aws.permission({
      actions: harnessInvokeActions(),
      resources: $util.all([harness.arn, harnessEndpoint.arn, runtime]).apply(([harnessArn, endpointArn, { arn }]) => (arn ? [harnessArn, endpointArn, arn] : [harnessArn, endpointArn])),
    }),
  ],
});

/** The WORLDS roles (purge, `memory.inspect`): the Memory's id, its namespaces and exactly MEMORY_ADMIN on it. */
export const Memory = new sst.Linkable(MEMORY_LINK, {
  properties: {
    memoryId: memory.memoryId,
    memoryArn: memory.memoryArn,
    tipsNamespace: MEMORY_STRATEGIES.installerTips.namespace,
    preferencesNamespace: MEMORY_STRATEGIES.installerPreferences.namespace,
    summaryNamespace: MEMORY_STRATEGIES.workOrderSummary.namespace,
    eventExpiryDays: MEMORY_EVENT_EXPIRY_DAYS,
  },
  include: CAPABILITIES.MEMORY_ADMIN.grants.map((grant) => {
    if (grant.resources.join() !== MEMORY_REF) throw new Error(`MEMORY_ADMIN names ${grant.resources.join(", ")}; the Memory link carries grants on ${MEMORY_REF} only.`);
    return sst.aws.permission({ actions: [...grant.actions], resources: [memory.memoryArn] });
  }),
});
