// The AgentCore Gateway of a local world: the Cedar statements the stage attaches (infra/policy-rules.ts,
// rendered for a local Gateway ARN and Harness role), evaluated with @cedar-policy/cedar-wasm against
// the schema the engine derives from the Gateway's tool schemas (infra/agent-tool-schemas.ts, generated
// from zod), in front of the five target Lambdas. Cedar sees what it sees in the stage: the Harness role,
// the action `<target>___<tool>`, the Gateway and `context.input`. A denied call (or one Cedar cannot
// even evaluate against the schema) never reaches its target; an allowed one reaches the target's
// Lambda entry with the context the Gateway gives it (`bedrockAgentCoreToolName`, …), so every fence of
// `createToolHandler` (`LAM-CALLER`, `LAM-SCOPE`, `LAM-KILL`, `LAM-STRICT`) runs as in the stage.
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { gatewayToolSchemas } from "../../../infra/agent-tool-schemas";
import { CEDAR_TYPES, GATEWAY_TARGETS, GATEWAY_TOOLS, type CedarPolicyDefinition, type GatewayTarget, assumedRoleEntityId, cedarPolicies, cedarSchema, inputSchemasByAction } from "../../../infra/policy-rules";
import type { ToolHandler, ToolResponse } from "../../../packages/bff/src/agent-tools/common/handler";
import { gatewayContext } from "../../../packages/bff/src/agent-tools/common/testing";

/** A made-up account: nothing in the local flows names a real account or ARN of the stage. */
export const LOCAL_ACCOUNT = "000000000000";

export const LOCAL_GATEWAY = {
  gatewayArn: `arn:aws:bedrock-agentcore:us-east-1:${LOCAL_ACCOUNT}:gateway/cuadrilla-local-flows`,
  harnessPrincipalId: assumedRoleEntityId(LOCAL_ACCOUNT, "cuadrilla-local-flows-harness"),
} as const;

const SCHEMA = cedarSchema(inputSchemasByAction(Object.fromEntries(GATEWAY_TARGETS.map((target) => [target, gatewayToolSchemas[target].inlinePayload])) as never));

export interface CedarDecision {
  readonly decision: "ALLOW" | "DENY";
  /** Names of the policies that decided (the permit, or the forbids that matched). */
  readonly determining: readonly string[];
  /** Why Cedar could not evaluate the request (an input outside the tool's schema): fail closed. */
  readonly error?: string;
}

export function evaluateCedar(policies: readonly CedarPolicyDefinition[], action: string, input: Readonly<Record<string, unknown>>, principal: string = LOCAL_GATEWAY.harnessPrincipalId): CedarDecision {
  const answer = cedar.isAuthorized({
    principal: { type: CEDAR_TYPES.principal, id: principal },
    action: { type: CEDAR_TYPES.action, id: action },
    resource: { type: CEDAR_TYPES.resource, id: LOCAL_GATEWAY.gatewayArn },
    context: { input } as cedar.Context,
    policies: { staticPolicies: Object.fromEntries(policies.map((policy) => [policy.name, policy.statement])) },
    entities: [],
    schema: SCHEMA,
    validateRequest: true,
  });
  if (answer.type !== "success") return { decision: "DENY", determining: [], error: answer.errors.map((error) => error.message).join("; ") };
  return { decision: answer.response.decision === "allow" ? "ALLOW" : "DENY", determining: [...answer.response.diagnostics.reason].sort() };
}

export interface GatewayCall {
  readonly target: GatewayTarget;
  readonly tool: string;
  readonly action: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cedar: CedarDecision;
  /** What the target answered; `undefined` when Cedar denied the call. */
  readonly output: ToolResponse | undefined;
}

export interface LocalGateway {
  readonly policies: readonly CedarPolicyDefinition[];
  /** Every call the Harness made through this Gateway, in order. */
  readonly calls: GatewayCall[];
  call(tool: string, input: Readonly<Record<string, unknown>>): Promise<GatewayCall>;
}

export function localPolicies(options: { readonly killSwitchActive?: boolean } = {}): CedarPolicyDefinition[] {
  return cedarPolicies(LOCAL_GATEWAY, options);
}

export function targetOfTool(tool: string): GatewayTarget {
  const target = GATEWAY_TARGETS.find((candidate) => GATEWAY_TOOLS[candidate].includes(tool));
  if (target === undefined) throw new Error(`the Gateway has no tool ${tool}`);
  return target;
}

export function createLocalGateway(targets: Readonly<Record<GatewayTarget, Pick<ToolHandler, "handler">>>, options: { readonly policies?: readonly CedarPolicyDefinition[] } = {}): LocalGateway {
  const policies = options.policies ?? localPolicies();
  const calls: GatewayCall[] = [];
  return {
    policies,
    calls,
    async call(tool, input) {
      const target = targetOfTool(tool);
      const action = `${target}___${tool}`;
      const decision = evaluateCedar(policies, action, input);
      const output = decision.decision === "DENY" ? undefined : await targets[target].handler({ ...input }, gatewayContext(action));
      const call: GatewayCall = { target, tool, action, input, cedar: decision, output };
      calls.push(call);
      return call;
    },
  };
}
