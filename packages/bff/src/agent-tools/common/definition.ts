// What a Gateway tool is, as data (docs/tool-catalog.md): its target, its name, who may invoke it,
// the zod schema of its arguments and the zod schema of its output. The schemas in
// `agent-tools/<target>/schema.ts` are the single source: `createToolHandler` validates every call
// with them (`LAM-STRICT`) and `npm run tools:build-schemas` lowers them into the `inlinePayload` of
// each `GatewayTarget` (common/gateway-schema.ts). This module has no runtime dependency (no SST, no
// SDK), so the build script and the infra program can import every schema.
//
// Rules a definition must follow, checked when it is defined (a broken schema fails at import):
//   - the tool name is snake_case and every Gateway tool is invocable by the Harness;
//   - the arguments and the output are strict objects (unknown keys are refused, never skimmed);
//   - `sessionToken` and `caller` are never declared: the handler adds the principal itself;
//   - a field Cedar forbids (`override`, `decision`, `force`) is declared with `deniedField`, so the
//     Gateway schema documents it ("never set; denied by policy …") and zod refuses any value.
import { z } from "zod";
import type { PrincipalKind } from "@cuadrilla/shared";

/** Gateway targets in chain order (docs/architecture.md §9.2); one Lambda per target. */
export const TOOL_TARGETS = ["orders", "knowledge", "evidence", "messaging", "cases"] as const;
export type ToolTarget = (typeof TOOL_TARGETS)[number];

/** Tool names: snake_case, the `<tool>` of the Gateway action `<target>___<tool>`. */
export const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;

/** Separator of the Gateway's tool names: `orders___get_work_orders`. */
export const GATEWAY_TOOL_SEPARATOR = "___";

/** Input keys the handler owns: the principal of the call (`LAM-CALLER`). No tool declares them. */
export const PRINCIPAL_FIELDS = ["sessionToken", "caller"] as const;

/** Metadata keys of a denied field, read by the Gateway lowering and by the handler. */
export const DENIED_BY_KEY = "x-denied-by";
export const GATEWAY_TYPE_KEY = "x-gateway-type";

/** Cedar statements that forbid a declared field (docs/design-brief.md §5.6). */
export const DeniedFieldRule = z.enum(["CED-NO-OVERRIDE", "CED-NO-SUPERVISOR-DECISION", "CED-NO-FORCE-CLOSE"]);
export type DeniedFieldRule = z.infer<typeof DeniedFieldRule>;

export function deniedFieldDescription(rule: DeniedFieldRule): string {
  return `never set; denied by policy ${rule}`;
}

/**
 * A field the schema declares only so Cedar can name it: optional in the Gateway schema, typed as
 * `type`, and refused by zod whatever its value (`LAM-STRICT`, ADR-0011).
 */
export function deniedField(type: "boolean" | "string", rule: DeniedFieldRule) {
  return z
    .never()
    .optional()
    .meta({ description: deniedFieldDescription(rule), [DENIED_BY_KEY]: rule, [GATEWAY_TYPE_KEY]: type });
}

export interface ToolDefinition<A extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject, F extends z.ZodObject = z.ZodObject> {
  readonly target: ToolTarget;
  readonly name: string;
  /** What the model reads in the tool list: when to call it and what it returns. */
  readonly description: string;
  /** Who may invoke it (docs/tool-catalog.md, "invocan"); every Gateway tool includes `HARNESS`. */
  readonly principals: readonly PrincipalKind[];
  /** Arguments without the principal; strict. */
  readonly args: A;
  /** Fields of a successful result next to `ok: true`; strict at every level. */
  readonly output: O;
  /** Fields a failure may carry next to `error` (the `missing` items of `NOT_COMPLETE`); strict. */
  readonly failure?: F;
  /** Denied fields of `args`, by field name. */
  readonly deniedFields: Readonly<Record<string, DeniedFieldRule>>;
}

export type ToolSpec<A extends z.ZodObject, O extends z.ZodObject, F extends z.ZodObject> = Omit<ToolDefinition<A, O, F>, "deniedFields">;

/** A registered metadata value of a schema, if any (zod's global registry). */
export function metaOf(schema: z.ZodType): Readonly<Record<string, unknown>> | undefined {
  return schema.meta() as Readonly<Record<string, unknown>> | undefined;
}

function isStrict(schema: z.ZodObject): boolean {
  return schema._zod.def.catchall?._zod.def.type === "never";
}

/** Every object nested in `schema` (through optionals, defaults and arrays) is strict. */
function strictEverywhere(schema: z.ZodType, path: string, problems: string[]): void {
  const def = schema._zod.def;
  switch (def.type) {
    case "object": {
      const object = schema as z.ZodObject;
      if (!isStrict(object)) problems.push(`${path} is not a strict object`);
      for (const [key, field] of Object.entries(object.shape)) strictEverywhere(field as z.ZodType, `${path}.${key}`, problems);
      return;
    }
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "nonoptional":
      strictEverywhere(Reflect.get(def, "innerType") as z.ZodType, path, problems);
      return;
    case "array":
      strictEverywhere(Reflect.get(def, "element") as z.ZodType, `${path}[]`, problems);
      return;
    default:
      return;
  }
}

/** The denied fields of an argument schema, by name. */
export function deniedFieldsOf(args: z.ZodObject): Record<string, DeniedFieldRule> {
  const denied: Record<string, DeniedFieldRule> = {};
  for (const [key, field] of Object.entries(args.shape)) {
    const rule = metaOf(field as z.ZodType)?.[DENIED_BY_KEY];
    if (rule !== undefined) denied[key] = DeniedFieldRule.parse(rule);
  }
  return denied;
}

/** Declares a Gateway tool; throws at import when the definition breaks a rule of this module. */
export function defineTool<A extends z.ZodObject, O extends z.ZodObject, F extends z.ZodObject = z.ZodObject>(spec: ToolSpec<A, O, F>): ToolDefinition<A, O, F> {
  const problems: string[] = [];
  const label = `${spec.target}___${spec.name}`;
  if (!TOOL_NAME.test(spec.name)) problems.push("the name is not snake_case");
  if (!(TOOL_TARGETS as readonly string[]).includes(spec.target)) problems.push(`unknown target "${spec.target}"`);
  if (spec.description.trim().length < 20) problems.push("the description is missing or too short for the model");
  if (!spec.principals.includes("HARNESS")) problems.push("a Gateway tool must be invocable by the Harness");
  if (new Set(spec.principals).size !== spec.principals.length) problems.push("principals repeat");
  for (const reserved of PRINCIPAL_FIELDS) if (reserved in spec.args.shape) problems.push(`"${reserved}" is the handler's, not an argument`);
  for (const reserved of ["ok", "error"]) {
    if (reserved in spec.output.shape) problems.push(`"${reserved}" belongs to the envelope, not to the output`);
    if (spec.failure !== undefined && reserved in spec.failure.shape) problems.push(`"${reserved}" belongs to the envelope, not to the failure fields`);
  }
  strictEverywhere(spec.args, "args", problems);
  strictEverywhere(spec.output, "output", problems);
  if (spec.failure !== undefined) strictEverywhere(spec.failure, "failure", problems);
  if (problems.length > 0) throw new Error(`tool ${label}: ${problems.join("; ")}`);
  return { ...spec, deniedFields: deniedFieldsOf(spec.args) };
}

/** The Gateway action id of a tool: `<target>___<tool>` (also Cedar's action id). */
export function gatewayToolName(definition: Pick<ToolDefinition, "target" | "name">): string {
  return `${definition.target}${GATEWAY_TOOL_SEPARATOR}${definition.name}`;
}
