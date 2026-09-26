import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readDoc } from "@cuadrilla/shared/testing";
import { gatewayToolSchemas } from "../../../../../infra/agent-tool-schemas";
import { GATEWAY_TARGETS, GATEWAY_TOOLS } from "../../../../../infra/policy-rules";
import { closeInstallationTool } from "../cases/schema";
import { updateChecklistTool } from "../evidence/schema";
import { searchProceduresTool } from "../knowledge/schema";
import { getWorkOrdersTool } from "../orders/schema";
import { EXPECTED_TOOL_COUNT, SCHEMA_MODULE_PATH, buildGatewayPayloads, buildSchemas, renderSchemaModule, toolCount } from "./build-schemas";
import { TOOL_CATALOG } from "./catalog";
import { TOOL_TARGETS, type ToolDefinition, defineTool } from "./definition";
import { GATEWAY_KEYWORDS, GATEWAY_SCHEMA_TYPES, type GatewaySchemaNode } from "./gateway-schema";

interface CatalogNode {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Record<string, CatalogNode>;
  readonly required?: string[];
  readonly items?: CatalogNode;
}

/** The input schema of each Gateway tool as docs/tool-catalog.md writes it, by target. */
function catalogInputs(): Record<string, Record<string, CatalogNode>> {
  const text = readDoc("docs/tool-catalog.md");
  const gateway = text.slice(text.indexOf("## Target `"), text.indexOf("## Handlers de invocación directa"));
  const byTarget: Record<string, Record<string, CatalogNode>> = {};
  for (const section of gateway.split(/^## Target /m).slice(1)) {
    const target = /^`([a-z]+)`/.exec(section)?.[1] ?? "";
    byTarget[target] = {};
    for (const match of section.matchAll(/^### `([a-z_]+)`\n[\s\S]*?```json\n([\s\S]*?)\n```/gm)) {
      byTarget[target][match[1] ?? ""] = (JSON.parse(match[2] ?? "{}") as { input: CatalogNode }).input;
    }
  }
  return byTarget;
}

/** Structure only: types, property names and nested structure (descriptions are the model's text). */
function shape(node: CatalogNode | GatewaySchemaNode, top = false): unknown {
  return {
    type: node.type,
    ...(node.properties === undefined ? {} : { properties: Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, shape(child)])) }),
    ...(node.items === undefined ? {} : { items: shape(node.items) }),
    ...(top ? { required: [...(node.required ?? [])].sort() } : {}),
  };
}

function walk(node: GatewaySchemaNode, visit: (node: GatewaySchemaNode, path: string) => void, path = ""): void {
  visit(node, path);
  for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, visit, `${path}.${key}`);
  if (node.items !== undefined) walk(node.items, visit, `${path}[]`);
}

const payloads = buildGatewayPayloads();
const catalog = catalogInputs();

describe("npm run tools:build-schemas", () => {
  it("builds 5 payloads with the 12 Gateway tools, the ones Cedar names, in chain order", () => {
    expect(Object.keys(payloads)).toEqual([...TOOL_TARGETS]);
    expect(TOOL_TARGETS).toEqual(GATEWAY_TARGETS);
    expect(toolCount(payloads)).toBe(EXPECTED_TOOL_COUNT);
    for (const target of TOOL_TARGETS) expect(payloads[target].inlinePayload.map((tool) => tool.name), target).toEqual([...GATEWAY_TOOLS[target]]);
  });

  it("matches the input schemas of docs/tool-catalog.md: properties, types, items and required fields", () => {
    for (const target of TOOL_TARGETS) {
      expect(Object.keys(catalog[target] ?? {}), target).toEqual(payloads[target].inlinePayload.map((tool) => tool.name));
      for (const tool of payloads[target].inlinePayload) {
        expect(shape(tool.inputSchema, true), `${target}___${tool.name}`).toEqual(shape(catalog[target]?.[tool.name] ?? {}, true));
      }
    }
  });

  it("uses only the Gateway keywords and types, requires sessionToken first and describes every property", () => {
    for (const tool of TOOL_TARGETS.flatMap((target) => payloads[target].inlinePayload)) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(Object.keys(tool.inputSchema.properties ?? {})[0]).toBe("sessionToken");
      expect(tool.inputSchema.required?.[0]).toBe("sessionToken");
      walk(tool.inputSchema, (node, path) => {
        expect(Object.keys(node).every((key) => (GATEWAY_KEYWORDS as readonly string[]).includes(key)), `${tool.name}${path}`).toBe(true);
        expect(GATEWAY_SCHEMA_TYPES, `${tool.name}${path}`).toContain(node.type);
        if (path !== "" && !path.endsWith("[]")) expect(node.description, `${tool.name}${path}`).toBeTruthy();
      });
    }
  });

  it("lowers enums, constants, defaults and lengths into the description the model reads", () => {
    const properties = (definition: ToolDefinition) => payloads[definition.target].inlinePayload.find((tool) => tool.name === definition.name)?.inputSchema.properties ?? {};
    expect(properties(getWorkOrdersTool).day?.description).toBe("Simulated day to list; one of: TODAY | TOMORROW; default TODAY");
    expect(properties(updateChecklistTool).item?.description).toContain("one of: ONU_ONLINE | POWER_READING_PHOTO | ONU_LABEL_PHOTO | ROSETTE_PHOTO");
    expect(properties(searchProceduresTool).query?.description).toContain("at most 300 characters");
    const whatsapp = payloads.messaging.inlinePayload[0]?.inputSchema.properties ?? {};
    expect(whatsapp.recipientRole).toEqual({ type: "string", description: expect.stringContaining("always INSTALLER") });
    expect(whatsapp.buttons?.description).toContain("at most 3 items");
  });

  it("declares override, decision and force as optional fields documented as never set", () => {
    for (const [target, tool, field, rule] of [
      ["evidence", "update_checklist", "override", "CED-NO-OVERRIDE"],
      ["cases", "escalate_case", "decision", "CED-NO-SUPERVISOR-DECISION"],
      ["cases", "close_installation", "force", "CED-NO-FORCE-CLOSE"],
    ] as const) {
      const input = payloads[target].inlinePayload.find((entry) => entry.name === tool)?.inputSchema;
      expect(input?.properties?.[field]?.description).toBe(`never set; denied by policy ${rule}`);
      expect(input?.required).not.toContain(field);
    }
    expect(updateChecklistTool.deniedFields).toEqual({ override: "CED-NO-OVERRIDE" });
    expect(closeInstallationTool.deniedFields).toEqual({ force: "CED-NO-FORCE-CLOSE" });
  });

  it("keeps infra/agent-tool-schemas.ts current: the committed module is what the zod schemas generate", () => {
    const committed = readFileSync(resolve(process.cwd(), SCHEMA_MODULE_PATH), "utf8");
    expect(committed).toBe(renderSchemaModule(payloads));
    expect(buildSchemas({ check: true })).toMatchObject({ changed: false, targets: 5, tools: 12 });
    expect(gatewayToolSchemas).toEqual(JSON.parse(JSON.stringify(payloads)));
  });
});

describe("tools:build-schemas fails instead of shipping a schema the Gateway would reject", () => {
  const bad = (args: z.ZodObject) =>
    defineTool({ target: "knowledge", name: "search_procedures", description: "A tool whose schema is under test in this file.", principals: ["HARNESS"], args, output: z.strictObject({}) });
  const withKnowledge = (...tools: ToolDefinition[]) => ({ ...TOOL_CATALOG, knowledge: tools });

  it("on a keyword or type the Gateway does not support (union, nullable, record)", () => {
    const either = z.union([z.strictObject({ a: z.string().describe("A") }), z.strictObject({ b: z.string().describe("B") })]).describe("Either");
    expect(() => buildGatewayPayloads(withKnowledge(bad(z.strictObject({ value: either }))))).toThrow(/unsupported keyword "anyOf"/);
    expect(() => buildGatewayPayloads(withKnowledge(bad(z.strictObject({ value: z.union([z.string(), z.number()]).describe("A value") }))))).toThrow(/unsupported type/);
    expect(() => buildGatewayPayloads(withKnowledge(bad(z.strictObject({ value: z.string().nullable().describe("A value") }))))).toThrow(/unsupported type \["string","null"\]/);
    expect(() => buildGatewayPayloads(withKnowledge(bad(z.strictObject({ value: z.record(z.string(), z.string()).describe("A map") }))))).toThrow(/unsupported keyword "propertyNames"/);
  });

  it("on a property the model could not read, a tool without schema, an empty target and a repeated name", () => {
    expect(() => buildGatewayPayloads(withKnowledge(bad(z.strictObject({ value: z.string() }))))).toThrow(/every property needs a description/);
    expect(() => buildGatewayPayloads(withKnowledge({ ...searchProceduresTool, args: undefined } as unknown as ToolDefinition))).toThrow(/has no schema/);
    expect(() => buildGatewayPayloads(withKnowledge())).toThrow(/target knowledge has no tool/);
    expect(() => buildGatewayPayloads({ ...TOOL_CATALOG, orders: [getWorkOrdersTool, getWorkOrdersTool] })).toThrow(/tool name get_work_orders repeats/);
  });

  it("rejects a definition that is not strict, declares the principal or is not the Harness's", () => {
    const spec = { target: "knowledge", name: "search_procedures", description: "A tool whose definition is under test here.", principals: ["HARNESS"], output: z.strictObject({}) } as const;
    expect(() => defineTool({ ...spec, args: z.object({ value: z.string() }) })).toThrow(/args is not a strict object/);
    expect(() => defineTool({ ...spec, args: z.strictObject({ refs: z.object({ id: z.string() }) }) })).toThrow(/args\.refs is not a strict object/);
    expect(() => defineTool({ ...spec, args: z.strictObject({ sessionToken: z.string() }) })).toThrow(/"sessionToken" is the handler's/);
    expect(() => defineTool({ ...spec, principals: ["WORKER"], args: z.strictObject({}) })).toThrow(/invocable by the Harness/);
    expect(() => defineTool({ ...spec, args: z.strictObject({}), output: z.strictObject({ ok: z.boolean() }) })).toThrow(/belongs to the envelope/);
  });
});
