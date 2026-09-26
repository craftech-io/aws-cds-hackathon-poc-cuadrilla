// AgentCore Policy engine and its Cedar policies (docs/design-brief.md §5.6, docs/architecture.md §9.2,
// docs/build-plan.md WP-08). The statements are plain data in infra/policy-rules.ts; this module only
// turns them into resources.
//
// Two halves, because the Gateway, its targets and the Harness role are created later, by
// infra/agentcore.ts (WP-26):
//
//   1. The engine is created here, now. It depends on no Gateway; infra/agentcore.ts passes
//      `{ arn: policyEngineArn, mode: GATEWAY_POLICY_ENGINE_MODE }` as the Gateway's
//      `policyEngineConfiguration`.
//   2. The policies are scoped to the Gateway ARN and to the Harness execution role, so they are created
//      by `attachGatewayPolicies`, which infra/agentcore.ts calls after the last GatewayTarget of the
//      chain: the engine validates every statement against the tool schemas of the Gateway it protects.
//      The call checks those same schemas first (every cited field declared, every read behind `has`,
//      every Gateway tool permitted) and fails the deploy with the list of problems instead of letting
//      the engine reject a policy halfway.
//
// Order: the five permits first (CED-PERMIT-<TARGET>), then every forbid with `dependsOn` all of them.
// Names: `enginePolicyName` (`cuadrilla_poc_CED_NO_OVERRIDE`), because policy names are unique across the
// engines of the shared account.
// CED-KILL-SWITCH exists only while KILL_SWITCH_ACTIVE is true in infra/policy-rules.ts (the runtime
// stop is `Runtime/KILL#`, ADR-0019); switching it on or off is a deploy through CI.
//
// Tags: the engine carries the app's tags (`bedrock-agentcore:Create*` requires `sst:app` on the CI
// role); the policies are untaggable children of the engine. Cost: per authorization request; nothing
// bills while the agent is idle.
//
// Verify (AWS CLI ≥ 2.27, or the SDK v3 scripts, docs/architecture.md §16):
//   aws --profile craftech-demos bedrock-agentcore-control list-policy-engines
//   aws --profile craftech-demos bedrock-agentcore-control list-policies --policy-engine-id <id>
//     → 14 policies ACTIVE, each named cuadrilla_poc_<statement>: CED_PERMIT_* ×5, CED_SESSION_* ×5,
//       CED_WA_INSTALLER_ONLY, CED_NO_OVERRIDE, CED_NO_SUPERVISOR_DECISION, CED_NO_FORCE_CLOSE; no
//       CED_KILL_SWITCH (switched off)
//   aws --profile craftech-demos bedrock-agentcore-control get-policy --policy-engine-id <id> --policy-id <cuadrilla_poc_CED_NO_OVERRIDE id>
//     → the statement of infra/policy-rules.ts with the real Gateway ARN and Harness role

import {
  GATEWAY_TARGETS,
  assumedRoleEntityId,
  cedarPolicies,
  creationPlan,
  enginePolicyName,
  inputSchemasByAction,
  policyEngineName,
  schemaProblems,
  type CedarPolicyDefinition,
  type CedarPolicyInputs,
  type GatewayTarget,
  type GatewayToolSchema,
} from "./policy-rules";
import { tagList } from "./tags";

/** How the Gateway applies the engine. The POC enforces from the first deploy. */
export const GATEWAY_POLICY_ENGINE_MODE = "ENFORCE" as const;

export const POLICY_ENGINE_NAME = policyEngineName($app.name, $app.stage);

export const policyEngine = new awsnative.bedrockagentcore.PolicyEngine("PolicyEngine", {
  name: POLICY_ENGINE_NAME,
  description: `Cedar fences (CED-*) of the ${$app.name} agent, stage ${$app.stage}: tool allowlist of the Harness role and static fences on tool arguments.`,
  tags: tagList(),
});

export const policyEngineArn = policyEngine.policyEngineArn;
export const policyEngineId = policyEngine.policyEngineId;

export interface AttachGatewayPoliciesArgs {
  /** ARN of the Gateway the policies protect. */
  readonly gatewayArn: $util.Input<string>;
  /** Name of the Harness execution role; Cedar identifies it as `arn:aws:sts::<account>:assumed-role/<name>`. */
  readonly harnessRoleName: $util.Input<string>;
  /** Names the `GatewayTarget`s were created with; must be exactly `GATEWAY_TARGETS`. */
  readonly targetNames: readonly string[];
  /** The `inlinePayload` of every target (infra/agent-tool-schemas.ts), the schemas the engine validates against. */
  readonly toolSchemas: Readonly<Record<GatewayTarget, readonly GatewayToolSchema[]>>;
  /** The last `GatewayTarget` of the chain, and anything else the schemas depend on. */
  readonly dependsOn?: $util.Resource[];
}

function assertTargetNames(names: readonly string[]): void {
  const missing = GATEWAY_TARGETS.filter((target) => !names.includes(target));
  const unknown = names.filter((name) => !(GATEWAY_TARGETS as readonly string[]).includes(name));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `GatewayTarget names must be the targets of infra/policy-rules.ts (Cedar action ids are "<target>___<tool>"). ` +
        `Missing: [${missing.join(", ")}]. Unknown: [${unknown.join(", ")}].`,
    );
  }
}

/**
 * Creates the Cedar policies in this stage's engine: permits first, then every forbid depending on all
 * of them. Returns them by name so the Harness can `dependsOn` them and never run a turn without the
 * fences in place.
 */
export function attachGatewayPolicies(args: AttachGatewayPoliciesArgs): Record<string, awsnative.bedrockagentcore.Policy> {
  assertTargetNames(args.targetNames);
  // The set of policies, their names and the fields they cite do not depend on the ARNs; only the
  // rendered statements do.
  const definitions = cedarPolicies({ gatewayArn: "<gateway>", harnessPrincipalId: "<harness>" });
  const problems = schemaProblems(definitions, inputSchemasByAction(args.toolSchemas));
  if (problems.length > 0) throw new Error(`Cedar policies do not match the Gateway tool schemas:\n  ${problems.join("\n  ")}`);

  const accountId = aws.getCallerIdentityOutput({}).accountId;
  const inputs: $util.Output<CedarPolicyInputs> = $util
    .all([args.gatewayArn, args.harnessRoleName, accountId])
    .apply(([gatewayArn, roleName, account]) => ({ gatewayArn, harnessPrincipalId: assumedRoleEntityId(account, roleName) }));

  const statementOf = (definition: CedarPolicyDefinition): $util.Output<string> =>
    inputs.apply((resolved) => {
      const rendered = cedarPolicies(resolved).find((candidate) => candidate.name === definition.name);
      if (rendered === undefined) throw new Error(`Cedar policy ${definition.name} disappeared while rendering.`);
      return rendered.statement;
    });

  const created: Record<string, awsnative.bedrockagentcore.Policy> = {};
  for (const step of creationPlan(definitions)) {
    const after = step.after.map((name) => {
      const policy = created[name];
      if (policy === undefined) throw new Error(`Cedar policy ${step.definition.name} must follow ${name}, which was not created first.`);
      return policy;
    });
    created[step.definition.name] = new awsnative.bedrockagentcore.Policy(
      `Policy${step.definition.name.replace(/_/g, "")}`,
      {
        policyEngineId,
        name: enginePolicyName($app.name, $app.stage, step.definition.name),
        description: step.definition.description,
        enforcementMode: step.definition.enforcementMode,
        validationMode: step.definition.validationMode,
        definition: { cedar: { statement: statementOf(step.definition) } },
      },
      { dependsOn: [...(args.dependsOn ?? []), ...after], parent: policyEngine },
    );
  }
  return created;
}
