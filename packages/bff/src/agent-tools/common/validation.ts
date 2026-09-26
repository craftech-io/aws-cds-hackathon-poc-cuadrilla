// zod at both edges of a tool (CLAUDE.md, "zod en todos los bordes").
//
// In: `LAM-STRICT`. The arguments are parsed with the tool's strict schema after the principal is
// taken out. A field Cedar forbids (`override`, `decision`, `force`) is refused with any value, and
// an argument the schema does not declare (an id the model made up, a key an injection added) is
// refused too; both are `INVALID` with `AuditLog DENY` naming the rules. Other shape errors are
// `INVALID` without an audit row: they are mistakes, not attempts.
//
// Out: the result the implementation returns is parsed with the tool's output schema before the model
// sees it, so no field outside the contract (a phone, an email, another installer's data) can leave.
// A result that does not match is logged as a bug and answered `UNAVAILABLE`.
import type { z } from "zod";
import { ToolErrorSchema, type ToolFailure, fail } from "@cuadrilla/shared";
import { PRINCIPAL_FIELDS, type ToolDefinition } from "./definition";
import { type DenialContext, auditToolDenial } from "./denials";

export const STRICT_RULE = "LAM-STRICT";

/** Reason codes of this module's failures. */
export const VALIDATION_REASON = { STRICT: STRICT_RULE, SHAPE: "VALIDATION", OUTPUT_INVALID: "OUTPUT_INVALID" } as const;

/** A successful or failed response as the caller receives it. */
export type ToolResponse = { readonly ok: true; readonly [field: string]: unknown } | (ToolFailure & { readonly [field: string]: unknown });

const MAX_REPORTED_KEYS = 10;

function reportedKeys(keys: readonly string[]): string[] {
  return keys.slice(0, MAX_REPORTED_KEYS).map((key) => key.slice(0, 64));
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length === 0 ? "input" : issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ");
}

export type ParsedArgs = { readonly ok: true; readonly args: unknown } | { readonly ok: false; readonly failure: ToolFailure };

/** The arguments of a call, validated; the principal fields are the handler's and never reach the tool. */
export async function parseArgs(ctx: DenialContext, definition: ToolDefinition, input: Readonly<Record<string, unknown>>): Promise<ParsedArgs> {
  const args = Object.fromEntries(Object.entries(input).filter(([key]) => !(PRINCIPAL_FIELDS as readonly string[]).includes(key)));
  const denied = Object.keys(args).filter((key) => definition.deniedFields[key] !== undefined);
  if (denied.length > 0) {
    const rules = [...new Set(denied.map((key) => definition.deniedFields[key] ?? STRICT_RULE))];
    await auditToolDenial(ctx, { ruleIds: [STRICT_RULE, ...rules], reason: "the call set a field that is never accepted", detail: { fields: denied } });
    return { ok: false, failure: fail("INVALID", `${denied.join(", ")} is never accepted: a person decides that`, STRICT_RULE) };
  }
  const parsed = definition.args.safeParse(args);
  if (parsed.success) return { ok: true, args: parsed.data };
  const unknown = parsed.error.issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys.map((key) => [...issue.path, key].map(String).join(".")) : []));
  if (unknown.length > 0) {
    await auditToolDenial(ctx, { ruleIds: [STRICT_RULE], reason: "the call carried arguments the tool does not declare", detail: { fields: reportedKeys(unknown) } });
    return { ok: false, failure: fail("INVALID", `unknown arguments: ${reportedKeys(unknown).join(", ")}`, STRICT_RULE) };
  }
  return { ok: false, failure: fail("INVALID", describeIssues(parsed.error), VALIDATION_REASON.SHAPE) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The response the caller receives for what the implementation returned. */
export function checkResult(ctx: Pick<DenialContext, "tool" | "logger">, definition: ToolDefinition, raw: unknown): ToolResponse {
  const broken = (detail: Record<string, unknown>): ToolResponse => {
    ctx.logger.error("tool.output.invalid", { tool: ctx.tool, metric: "ToolErrors", value: 1, ...detail });
    return fail("UNAVAILABLE", "temporary failure, try again later", VALIDATION_REASON.OUTPUT_INVALID);
  };
  if (!isRecord(raw) || typeof raw.ok !== "boolean") return broken({ problem: "not a { ok } result" });
  const { ok, error, ...fields } = raw;
  if (ok) {
    const output = definition.output.safeParse(fields);
    if (!output.success) return broken({ problem: "output outside the schema", paths: output.error.issues.map((issue) => issue.path.map(String).join(".")).slice(0, 10) });
    return { ok: true, ...(output.data as Record<string, unknown>) };
  }
  const parsedError = ToolErrorSchema.safeParse(error);
  if (!parsedError.success) return broken({ problem: "failure without a valid error" });
  const failure: ToolFailure = { ok: false, error: parsedError.data };
  if (Object.keys(fields).length === 0) return failure;
  const declared = definition.failure?.shape ?? {};
  const dropped = Object.keys(fields).filter((key) => !(key in declared));
  const extras = definition.failure?.safeParse(Object.fromEntries(Object.entries(fields).filter(([key]) => key in declared)));
  if (dropped.length > 0 || extras?.success !== true) ctx.logger.warn("tool.failure.extras_dropped", { tool: ctx.tool, fields: reportedKeys(extras?.success === true ? dropped : Object.keys(fields)) });
  return extras?.success === true ? { ...failure, ...(extras.data as Record<string, unknown>) } : failure;
}
