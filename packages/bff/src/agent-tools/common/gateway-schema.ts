// Lowers the zod schema of a tool into the subset of JSON Schema an AgentCore Gateway target accepts
// (docs/tool-catalog.md, "Schemas del Gateway"; SchemaDefinition of the control API): only `type`,
// `properties`, `required`, `items` and `description`, with `type` one of string, number, integer,
// boolean, array or object. What the Gateway cannot say moves into the description the model reads
// (enum values, constants, defaults, lengths); what is only validation (patterns, bounds, strictness)
// stays in zod, which the handler applies to every call (`LAM-STRICT`). Any other keyword, or a
// property without a description, is an error: the build fails instead of shipping a schema the
// Gateway would reject or the model could not read.
import { z } from "zod";
import { DENIED_BY_KEY, GATEWAY_TYPE_KEY, type ToolDefinition, gatewayToolName } from "./definition";

export const GATEWAY_SCHEMA_TYPES = ["string", "number", "integer", "boolean", "array", "object"] as const;
export type GatewaySchemaType = (typeof GATEWAY_SCHEMA_TYPES)[number];

/** The keywords a Gateway schema may carry, and nothing else. */
export const GATEWAY_KEYWORDS = ["type", "description", "properties", "required", "items"] as const;

export interface GatewaySchemaNode {
  readonly type: GatewaySchemaType;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, GatewaySchemaNode>>;
  readonly required?: readonly string[];
  readonly items?: GatewaySchemaNode;
}

/** One entry of a target's `inlinePayload` (`ToolDefinition` of the control API, without output schema). */
export interface GatewayToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: GatewaySchemaNode & { readonly type: "object" };
}

/** The principal every Gateway call carries; the handler checks it (`LAM-CALLER`, `LAM-SCOPE`). */
export const SESSION_TOKEN_DESCRIPTION =
  "Session token of this turn: copy the token attribute of the <session …/> header verbatim. Every call needs it; the tool derives installer, work order and operator from it.";

// Keywords zod emits that the lowering folds into the description or drops because zod enforces them.
const FOLDED = new Set(["enum", "const", "default", "maxLength", "maxItems"]);
const DROPPED = new Set(["$schema", "additionalProperties", "minLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems"]);

export class GatewaySchemaError extends Error {
  override readonly name = "GatewaySchemaError";
}

type JsonNode = Readonly<Record<string, unknown>>;

function isGatewayType(value: unknown): value is GatewaySchemaType {
  return typeof value === "string" && (GATEWAY_SCHEMA_TYPES as readonly string[]).includes(value);
}

function literal(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The description the model reads: the author's text plus what the Gateway cannot express. */
function describe(node: JsonNode, path: string): string | undefined {
  const parts: string[] = [];
  if (node.description !== undefined) parts.push(String(node.description));
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.some((value) => typeof value !== "string")) throw new GatewaySchemaError(`${path}: only string enums can be lowered`);
    parts.push(`one of: ${node.enum.join(" | ")}`);
  }
  if (node.const !== undefined) parts.push(`always ${literal(node.const)}`);
  if (node.default !== undefined) parts.push(`default ${literal(node.default)}`);
  if (typeof node.maxLength === "number") parts.push(`at most ${node.maxLength} characters`);
  if (typeof node.maxItems === "number") parts.push(`at most ${node.maxItems} items`);
  return parts.length === 0 ? undefined : parts.join("; ");
}

function lowerDenied(node: JsonNode, path: string): GatewaySchemaNode {
  const type = node[GATEWAY_TYPE_KEY];
  if (!isGatewayType(type)) throw new GatewaySchemaError(`${path}: a denied field needs its Gateway type`);
  const extra = Object.keys(node).filter((key) => ![DENIED_BY_KEY, GATEWAY_TYPE_KEY, "description", "not"].includes(key));
  if (extra.length > 0) throw new GatewaySchemaError(`${path}: unsupported keyword "${extra[0]}" on a denied field`);
  return { type, description: String(node.description) };
}

function lowerNode(node: JsonNode, path: string, isProperty: boolean): GatewaySchemaNode {
  if (node[DENIED_BY_KEY] !== undefined) return lowerDenied(node, path);
  const unsupported = Object.keys(node).find((key) => !(GATEWAY_KEYWORDS as readonly string[]).includes(key) && !FOLDED.has(key) && !DROPPED.has(key));
  if (unsupported !== undefined) throw new GatewaySchemaError(`${path}: unsupported keyword "${unsupported}"`);
  if (!isGatewayType(node.type)) throw new GatewaySchemaError(`${path}: unsupported type ${JSON.stringify(node.type)}`);
  const description = describe(node, path);
  if (isProperty && description === undefined) throw new GatewaySchemaError(`${path}: every property needs a description for the model`);
  const lowered: { -readonly [K in keyof GatewaySchemaNode]: GatewaySchemaNode[K] } = { type: node.type };
  if (description !== undefined) lowered.description = description;
  if (node.type === "object" && node.properties !== undefined) {
    const properties: Record<string, GatewaySchemaNode> = {};
    for (const [key, child] of Object.entries(node.properties as Record<string, JsonNode>)) properties[key] = lowerNode(child, `${path}.${key}`, true);
    lowered.properties = properties;
    const required = (node.required as string[] | undefined) ?? [];
    if (required.length > 0) lowered.required = [...required];
  } else if (node.properties !== undefined || node.required !== undefined) {
    throw new GatewaySchemaError(`${path}: properties on a ${node.type}`);
  }
  if (node.type === "array") {
    if (node.items === undefined || typeof node.items !== "object" || Array.isArray(node.items)) throw new GatewaySchemaError(`${path}: an array needs one items schema`);
    lowered.items = lowerNode(node.items as JsonNode, `${path}[]`, false);
  } else if (node.items !== undefined) {
    throw new GatewaySchemaError(`${path}: items on a ${node.type}`);
  }
  return lowered;
}

/** JSON Schema of the arguments as zod sees the input side (defaults make a field optional). */
function argsJsonSchema(definition: ToolDefinition): JsonNode {
  try {
    return z.toJSONSchema(definition.args, { io: "input", unrepresentable: "throw", reused: "inline" }) as JsonNode;
  } catch (error) {
    throw new GatewaySchemaError(`${gatewayToolName(definition)}: the arguments cannot be written as JSON Schema (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** The Gateway entry of one tool: `sessionToken` first and required, then the tool's own arguments. */
export function gatewayToolSchema(definition: ToolDefinition): GatewayToolSchema {
  const name = gatewayToolName(definition);
  const args = lowerNode(argsJsonSchema(definition), name, false);
  if (args.type !== "object") throw new GatewaySchemaError(`${name}: the arguments must be an object`);
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: {
      type: "object",
      properties: { sessionToken: { type: "string", description: SESSION_TOKEN_DESCRIPTION }, ...args.properties },
      required: ["sessionToken", ...(args.required ?? [])],
    },
  };
}
