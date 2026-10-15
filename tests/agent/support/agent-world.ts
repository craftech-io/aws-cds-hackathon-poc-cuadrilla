// The agent scenarios of Cuadrilla (tests/agent, run by `agent-test run`): the local flow world of
// tests/flows with the kit's model-backed Harness in place of the scripted one. Everything around the turn is
// the stage's code as the flows run it: the inbound channel, the media checks and the Transcribe fake, the
// lexicon classifier and the G1 pre-filter (over the guardrail fake of tests/flows/support/aws.ts), the
// worker's preloaded reads (ADR-0028), the product's Harness client, the Gateway with the stage's Cedar
// statements evaluated locally, the five tool targets and the outbound pipeline with G2 (the same fake).
// Only the model differs: Qwen on Ollama by default, USD 0. The system prompt, the Gateway tool schemas and
// the Harness limits are imported from what infra deploys, never copied. G4 rides inside the deployed
// Harness and has no local stand-in: the kit's Harness applies no guardrail (its stop reasons are covered
// by the unit tests of agent/harness-client.ts and worker/guardrail-block.ts). The folder is outside
// `npm test` and the root tsconfig: CI never sees it.
import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { type CallTool, type LocalHarness, type LocalTurn, type ToolSpec, createLocalHarness, fromEnv } from "@craftech/agent-testkit";
import { afterEach, expect } from "vitest";
import { gatewayToolSchemas } from "../../../infra/agent-tool-schemas";
import { HARNESS_LIMITS } from "../../../infra/agentcore-spec";
import { GATEWAY_TARGETS, GATEWAY_TOOLS } from "../../../infra/policy-rules";
import { SYSTEM_PROMPT } from "../../../packages/bff/src/agent/system-prompt";
import type { LocalGateway } from "../../flows/support/gateway";
import { createFlowWorld, type FlowWorld } from "../../flows/support/world";
import { LOCAL_HARNESS } from "../../flows/support/worker";
import { withLocalRetries } from "./local-model";

/**
 * What a local model may take for one turn before the product's Harness client gives up. The stage's 90 s
 * fit Sonnet; a 27B model on a laptop needs more for a turn of five tool calls. It stays under the worker's
 * own budget (`DEFAULT_REMAINING_MS` minus the closing margin), so the client's deadline still holds.
 */
export const LOCAL_MODEL_TURN_SECONDS = 300;

/** The Gateway's tools as the Harness shows them to the model: `<target>___<tool>`, with the deployed inline schema. */
export const AGENT_TOOLS: readonly ToolSpec[] = GATEWAY_TARGETS.flatMap((target) =>
  gatewayToolSchemas[target].inlinePayload.map((tool) => ({ name: `${target}___${tool.name}`, description: tool.description, inputSchema: tool.inputSchema as unknown as ToolSpec["inputSchema"] })),
);

const TOOL_NAMES = new Set(GATEWAY_TARGETS.flatMap((target) => GATEWAY_TOOLS[target]));
const REQUIRED = new Map(GATEWAY_TARGETS.flatMap((target) => gatewayToolSchemas[target].inlinePayload.map((tool) => [tool.name, tool.inputSchema.required ?? []] as const)));

/** The tool of a name the model wrote (`orders___get_onu_status` or the bare `get_onu_status`). */
export function toolOf(name: string): string {
  return name.split("___").at(-1) ?? name;
}

/**
 * One tool call through the world's Gateway, as the stage answers it: an input without a required field of the
 * tool's schema is refused before any policy (the Gateway validates against the inline schema and names the
 * field); then Cedar, whose DENY reaches the model as an error result with the deciding policies (or, for an
 * input the schema-typed request cannot carry, Cedar's reason); then the target.
 */
export function gatewayCaller(gateway: LocalGateway): CallTool {
  return async (name, input) => {
    const tool = toolOf(name);
    if (!TOOL_NAMES.has(tool)) return { status: "error", output: { error: "UnknownToolException", tool: name } };
    const missing = (REQUIRED.get(tool) ?? []).filter((field) => input[field] === undefined);
    if (missing.length > 0) return { status: "error", output: { error: "ValidationException", message: `missing required field(s): ${missing.join(", ")}` } };
    const call = await gateway.call(tool, input);
    if (call.cedar.decision === "DENY") return { status: "error", output: { error: "AccessDeniedException", policies: call.cedar.determining, ...(call.cedar.error === undefined ? {} : { reason: call.cedar.error }) } };
    return { status: "success", output: call.output };
  };
}

export interface AgentWorld {
  readonly flow: FlowWorld;
  readonly agent: LocalHarness;
}

/** Registers the `afterEach` that forgets the world; `open` builds one with the run's model. */
export function useAgentWorld(): { open(): Promise<AgentWorld> } {
  let current: LocalHarness | undefined;
  afterEach(() => {
    current?.reset();
    current = undefined;
  });
  return {
    async open() {
      const env = fromEnv({ label: () => expect.getState().currentTestName });
      if (env === undefined) throw new Error("tests/agent need a model: run them with `agent-test run` (qwen by default).");
      let agent: LocalHarness | undefined;
      const flow = await createFlowWorld({
        harness: (gateway) => {
          agent = createLocalHarness({
            model: withLocalRetries(env.model),
            systemPrompt: SYSTEM_PROMPT,
            tools: AGENT_TOOLS,
            callTool: gatewayCaller(gateway),
            limits: { maxIterations: HARNESS_LIMITS.maxIterations, maxTokens: HARNESS_LIMITS.maxTokens, slidingWindowMessages: HARNESS_LIMITS.slidingWindowMessages, timeoutSeconds: LOCAL_MODEL_TURN_SECONDS },
            budget: env.budget,
            temperature: 0,
            ...(env.recorder === undefined ? {} : { recorder: env.recorder }),
          });
          const harness = agent;
          return {
            link: { ...LOCAL_HARNESS, maxIterations: HARNESS_LIMITS.maxIterations, maxTokens: HARNESS_LIMITS.maxTokens, timeoutSeconds: LOCAL_MODEL_TURN_SECONDS },
            agentMode: "REAL",
            send: async (input) => {
              const { stream } = await harness.invoke(input);
              return { stream: stream as AsyncIterable<InvokeHarnessStreamOutput> };
            },
          };
        },
      });
      if (agent === undefined) throw new Error("the world did not build its Harness");
      current = agent;
      return { flow, agent };
    },
  };
}

/** Names of the tools a turn called, without the target prefix. */
export const toolsOf = (turn: { readonly calls: ReadonlyArray<{ readonly name: string }> } | undefined): string[] => (turn?.calls ?? []).map((call) => toolOf(call.name));

/** The calls of a tool across turns, with their outputs. */
export const callsOf = (turns: readonly LocalTurn[], tool: string) => turns.flatMap((turn) => turn.calls).filter((call) => toolOf(call.name) === tool);

/** How the turns ended, for a failure message: `end_turn:get_onu_status,send_whatsapp "…"`. */
export function turnsSummary(turns: readonly LocalTurn[]): string {
  return turns.map((turn) => `${turn.stopReason}:${toolsOf(turn).join(",") || "-"} "${turn.text.replace(/\s+/g, " ").slice(0, 160)}"`).join(" | ") || "no turn";
}
