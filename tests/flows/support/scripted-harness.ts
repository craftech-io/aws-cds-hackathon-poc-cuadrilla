// The scripted Harness of the local flows (docs/test-plan.md §2, level LF): instead of a model, a plan
// of Gateway tool calls written by the test. It reads the envelope the worker built (agent/envelope.ts:
// the session token, the event, the untrusted text inside its block, the photo attachment and the reads
// the worker preloaded) and runs each call through the local Gateway (gateway.ts: the stage's Cedar
// statements, then the target Lambdas). Everything around the plan is the stage's code: the worker
// invokes it through the product's Harness client (agent/harness-client.ts), whose `send` this answers
// with the stream `InvokeHarness` would produce, so the turn's note, stop reason, tool uses and usage
// are read exactly as in the stage.
import type { InvokeHarnessCommandInput, InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import type { TurnTrigger } from "@cuadrilla/shared";
import type { GatewayCall, LocalGateway } from "./gateway";

export interface ReadEnvelope {
  readonly text: string;
  readonly sessionToken: string;
  readonly event: { readonly type: TurnTrigger; readonly id: string; readonly at: string; readonly workOrder?: string };
  /** The untrusted text of the turn (unescaped), when the installer wrote or spoke. */
  readonly inbound?: string;
  readonly inboundKind?: string;
  readonly candidateId?: string;
  /** The item of the attachment: the one the installer chose with a CHOOSE_ITEM button for that photo. */
  readonly item?: string;
  /** The reads the worker ran before the Harness, by tool (ADR-0028). */
  readonly preloaded: Readonly<Record<string, unknown>>;
}

const unescape = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function attribute(line: string | undefined, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(line ?? "");
  return match === null ? undefined : unescape(match[1] ?? "");
}

/** What a model reads in the envelope. */
export function readEnvelope(text: string): ReadEnvelope {
  const session = /^<session [^>]*\/>/m.exec(text)?.[0];
  const sessionToken = attribute(session, "token");
  const delim = attribute(session, "delim");
  const eventLine = /^<event [^>]*\/>/m.exec(text)?.[0];
  const type = attribute(eventLine, "type");
  if (sessionToken === undefined || delim === undefined || type === undefined) throw new Error("not an envelope of a turn");
  const block = new RegExp(`<${delim}([^>]*)>([\\s\\S]*?)</${delim}>`).exec(text);
  const preloaded: Record<string, unknown> = {};
  for (const match of text.matchAll(/^<tool-result tool="([a-z_]+)">(.*)<\/tool-result>$/gm)) preloaded[match[1] ?? ""] = JSON.parse(match[2] ?? "null");
  const workOrder = attribute(eventLine, "workOrder");
  const attachment = /^<attachment [^>]*\/>/m.exec(text)?.[0];
  const candidateId = attribute(attachment, "candidateId");
  const item = attribute(attachment, "item");
  return {
    text,
    sessionToken,
    event: { type: type as TurnTrigger, id: attribute(eventLine, "id") ?? "", at: attribute(eventLine, "at") ?? "", ...(workOrder === undefined ? {} : { workOrder }) },
    ...(block === null ? {} : { inbound: unescape(block[2] ?? ""), ...(attribute(block[1], "kind") === undefined ? {} : { inboundKind: attribute(block[1], "kind") }) }),
    ...(candidateId === undefined ? {} : { candidateId }),
    ...(item === undefined ? {} : { item }),
    preloaded,
  };
}

export interface PlanContext {
  readonly envelope: ReadEnvelope;
  /** Calls already made in this turn, in order: their outputs feed later inputs. */
  readonly calls: readonly GatewayCall[];
}

export type PlanInput = Readonly<Record<string, unknown>> | ((context: PlanContext) => Readonly<Record<string, unknown>>);

export interface PlanStep {
  readonly tool: string;
  /** Arguments as a model writes them; `sessionToken` is copied from the envelope. */
  readonly input: PlanInput;
  /** The model leaves the token out (the `CED-SESSION-*` forbids fence it). */
  readonly withoutSessionToken?: boolean;
  /** The model makes this call only when what it read earlier in the turn says so. */
  readonly when?: (context: PlanContext) => boolean;
}

export interface Plan {
  readonly steps: readonly PlanStep[];
  /** Final text: an internal note (ADR-0014), never a message to anyone. */
  readonly note?: string;
  readonly stopReason?: string;
}

/** Chooses the plan of a turn from what the model would read. */
export type PlanSource = (envelope: ReadEnvelope) => Plan;

export interface ScriptedTurn {
  readonly envelope: ReadEnvelope;
  readonly calls: readonly GatewayCall[];
  readonly note: string;
  readonly stopReason: string;
  readonly runtimeSessionId?: string;
  readonly actorId?: string;
}

export interface ScriptedHarness {
  readonly turns: ScriptedTurn[];
  /** Plans that could not run (a bug of the test's plan, never of the product): the turn failed. */
  readonly errors: Error[];
  /** Plans the test queued for the next turns, used before the default source. */
  readonly next: Plan[];
  /** `InvokeHarness` answered like the SDK: the turn runs, then its stream is returned. */
  send(input: InvokeHarnessCommandInput): Promise<{ readonly stream: AsyncIterable<InvokeHarnessStreamOutput> }>;
}

/** The text of the user message of an `InvokeHarness` request. */
export function invocationText(input: Pick<InvokeHarnessCommandInput, "messages">): string {
  const user = [...(input.messages ?? [])].reverse().find((message) => message.role === "user");
  const text = (user?.content ?? []).flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : [])).join("\n");
  if (text === "") throw new Error("InvokeHarness without a user message");
  return text;
}

async function* streamOf(turn: ScriptedTurn, index: number): AsyncGenerator<InvokeHarnessStreamOutput> {
  yield { messageStart: { role: "assistant" } } as InvokeHarnessStreamOutput;
  let block = 0;
  for (const [position, call] of turn.calls.entries()) {
    const id = `tooluse_${index}_${position}`;
    yield { contentBlockStart: { contentBlockIndex: block, start: { toolUse: { toolUseId: id, name: call.action } } } } as InvokeHarnessStreamOutput;
    yield { contentBlockDelta: { contentBlockIndex: block, delta: { toolUse: { input: JSON.stringify(call.input) } } } } as InvokeHarnessStreamOutput;
    yield { contentBlockStop: { contentBlockIndex: block } } as InvokeHarnessStreamOutput;
    block += 1;
  }
  yield { contentBlockDelta: { contentBlockIndex: block, delta: { text: turn.note } } } as InvokeHarnessStreamOutput;
  yield { contentBlockStop: { contentBlockIndex: block } } as InvokeHarnessStreamOutput;
  yield { messageStop: { stopReason: turn.stopReason } } as InvokeHarnessStreamOutput;
  yield { metadata: { usage: { inputTokens: 1_200, outputTokens: 150, totalTokens: 1_350 } } } as InvokeHarnessStreamOutput;
}

export function createScriptedHarness(options: { readonly gateway: LocalGateway; readonly plans: PlanSource }): ScriptedHarness {
  const turns: ScriptedTurn[] = [];
  const errors: Error[] = [];
  const next: Plan[] = [];
  async function run(envelope: ReadEnvelope, plan: Plan): Promise<GatewayCall[]> {
    const calls: GatewayCall[] = [];
    for (const step of plan.steps) {
      const context = { envelope, calls };
      if (step.when !== undefined && !step.when(context)) continue;
      const written = typeof step.input === "function" ? step.input(context) : step.input;
      calls.push(await options.gateway.call(step.tool, step.withoutSessionToken === true ? { ...written } : { ...written, sessionToken: envelope.sessionToken }));
    }
    return calls;
  }
  return {
    turns,
    errors,
    next,
    async send(input) {
      const envelope = readEnvelope(invocationText(input));
      const plan = next.shift() ?? options.plans(envelope);
      let calls: GatewayCall[];
      try {
        calls = await run(envelope, plan);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      const turn: ScriptedTurn = {
        envelope,
        calls,
        note: plan.note ?? "Turno guionado.",
        stopReason: plan.stopReason ?? "end_turn",
        ...(input.runtimeSessionId === undefined ? {} : { runtimeSessionId: input.runtimeSessionId }),
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      };
      turns.push(turn);
      return { stream: streamOf(turn, turns.length - 1) };
    },
  };
}
