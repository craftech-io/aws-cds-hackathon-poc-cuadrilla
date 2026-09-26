import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { describe, expect, it } from "vitest";
import {
  CEDAR_STATEMENT_IDS,
  CEDAR_TYPES,
  GATEWAY_TARGETS,
  GATEWAY_TOOLS,
  KILL_SWITCH_ACTIVE,
  MAX_STATEMENT_CHARS,
  actionId,
  allActionIds,
  assumedRoleEntityId,
  cedarPolicies,
  cedarSchema,
  creationPlan,
  inputSchemasByAction,
  policyEngineName,
  policyName,
  schemaProblems,
  type CedarPolicyDefinition,
  type CedarSchemaJson,
  type GatewayTarget,
  type GatewayToolSchema,
  type JsonSchemaNode,
  type ToolInputSchemas,
} from "./policy-rules";

const ACCOUNT = "776805327629";
// Worst case of what infra/agentcore.ts can pass: an IAM role name of 64 characters and a Gateway id of 100.
const inputs = {
  gatewayArn: `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:gateway/${"aws-cds-hackathon-poc-cuadrilla-poc-".padEnd(100, "x")}`,
  harnessPrincipalId: assumedRoleEntityId(ACCOUNT, "aws-cds-hackathon-poc-cuadrilla-poc-HarnessRole".padEnd(64, "z")),
};
const policies = cedarPolicies(inputs);
const switchedOn = cedarPolicies(inputs, { killSwitchActive: true });
const byId = (id: string, set: readonly CedarPolicyDefinition[] = policies): CedarPolicyDefinition => {
  const found = set.find((policy) => policy.id === id);
  if (found === undefined) throw new Error(`no policy ${id}`);
  return found;
};

/** The Gateway tools of docs/tool-catalog.md, by target, with the input schema each one documents. */
function readCatalog(): { tools: Record<string, string[]>; schemas: ToolInputSchemas } {
  const text = readFileSync(resolve(process.cwd(), "docs/tool-catalog.md"), "utf8");
  const gateway = text.slice(text.indexOf("## Target `"), text.indexOf("## Handlers de invocación directa"));
  const tools: Record<string, string[]> = {};
  const schemas: Record<string, JsonSchemaNode> = {};
  for (const section of gateway.split(/^## Target /m).slice(1)) {
    const target = /^`([a-z]+)`/.exec(section)?.[1] ?? "";
    tools[target] = [];
    for (const match of section.matchAll(/^### `([a-z_]+)`\n[\s\S]*?```json\n([\s\S]*?)\n```/gm)) {
      const tool = match[1] ?? "";
      tools[target].push(tool);
      schemas[`${target}___${tool}`] = (JSON.parse(match[2] ?? "{}") as { input: JsonSchemaNode }).input;
    }
  }
  return { tools, schemas };
}
const catalog = readCatalog();
const schema = cedarSchema(catalog.schemas);

// The Gateway payloads generated from zod (`npm run tools:build-schemas`, WP-25), once they exist.
const generatedModule: object = await import("./agent-tool-schemas");
const generated = Reflect.get(generatedModule, "gatewayToolSchemas") as Record<GatewayTarget, { inlinePayload: GatewayToolSchema[] }> | undefined;

const SESSION = "ses_01.turn_01.1760000000.c2lnbmF0dXJl";

/** The smallest input the catalog schema accepts, with the recipient the fences expect. */
function validInput(action: string): Record<string, unknown> {
  const sample = (node: JsonSchemaNode): unknown => {
    if (node.type === "object") return Object.fromEntries((node.required ?? []).map((field) => [field, sample(node.properties?.[field] ?? {})]));
    if (node.type === "boolean") return false;
    if (node.type === "integer") return 1;
    if (node.type === "array") return [];
    return "x";
  };
  const input = sample(catalog.schemas[action] ?? {}) as Record<string, unknown>;
  return { ...input, sessionToken: SESSION, ...(action === "messaging___send_whatsapp" ? { recipientRole: "INSTALLER" } : {}) };
}

interface Decision {
  readonly decision: "allow" | "deny";
  readonly reasons: readonly string[];
  readonly errors: readonly string[];
}

/** Real Cedar (cedar-wasm): the decision for a Gateway call of the Harness, with the catalog schema. */
function authorize(set: readonly CedarPolicyDefinition[], action: string, input: Record<string, unknown>, options: { principal?: string; resource?: string; validate?: boolean } = {}): Decision {
  const answer = cedar.isAuthorized({
    principal: { type: CEDAR_TYPES.principal, id: options.principal ?? inputs.harnessPrincipalId },
    action: { type: CEDAR_TYPES.action, id: action },
    resource: { type: CEDAR_TYPES.resource, id: options.resource ?? inputs.gatewayArn },
    context: { input } as cedar.Context,
    policies: { staticPolicies: Object.fromEntries(set.map((policy) => [policy.name, policy.statement])) },
    entities: [],
    ...(options.validate === false ? {} : { schema, validateRequest: true }),
  });
  if (answer.type !== "success") throw new Error(answer.errors.map((error) => error.message).join("\n"));
  return { decision: answer.response.decision, reasons: [...answer.response.diagnostics.reason].sort(), errors: answer.response.diagnostics.errors.map((error) => error.policyId) };
}

function validate(set: readonly CedarPolicyDefinition[], cedarSchemaJson: CedarSchemaJson = schema): { errors: string[]; warnings: string[] } {
  const answer = cedar.validate({
    schema: cedarSchemaJson,
    policies: { staticPolicies: Object.fromEntries(set.map((policy) => [policy.name, policy.statement])) },
    validationSettings: { mode: "strict" },
  });
  if (answer.type !== "success") throw new Error(answer.errors.map((error) => error.message).join("\n"));
  return { errors: answer.validationErrors.map((error) => `${error.policyId}: ${error.error.message}`), warnings: answer.validationWarnings.map((warning) => warning.policyId).sort() };
}

describe("statements", () => {
  it("renders every CED-* id once, in creation order, with a valid unique name; the kill switch only while active", () => {
    expect(policies.map((policy) => policy.id)).toEqual(CEDAR_STATEMENT_IDS.filter((id) => id !== "CED-KILL-SWITCH"));
    expect(switchedOn.map((policy) => policy.id)).toEqual([...CEDAR_STATEMENT_IDS]);
    for (const policy of switchedOn) {
      expect(policy.name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,47}$/);
      expect(policy.name).toBe(policyName(policy.id));
      expect(policy.statement.startsWith(`// ${policy.id}\n${policy.effect}(\n  principal == AgentCore::IamEntity::"${inputs.harnessPrincipalId}",`)).toBe(true);
      expect(policy.statement).toContain(`resource == AgentCore::Gateway::"${inputs.gatewayArn}"`);
      expect(policy.statement.endsWith(";")).toBe(true);
      expect(policy.enforcementMode).toBe("ACTIVE");
    }
    expect(new Set(switchedOn.map((policy) => policy.name)).size).toBe(switchedOn.length);
    expect(policyEngineName("aws-cds-hackathon-poc-cuadrilla", "poc")).toBe("aws_cds_hackathon_poc_cuadrilla_poc");
  });

  it("permits exactly the 12 Gateway tools of docs/tool-catalog.md, one permit per target (CED-PERMIT-<TARGET>)", () => {
    expect(catalog.tools).toEqual(Object.fromEntries(GATEWAY_TARGETS.map((target) => [target, [...GATEWAY_TOOLS[target]]])));
    expect(allActionIds()).toHaveLength(12);
    const permits = policies.filter((policy) => policy.effect === "permit");
    expect(permits.map((policy) => policy.id)).toEqual(GATEWAY_TARGETS.map((target) => `CED-PERMIT-${target.toUpperCase()}`));
    GATEWAY_TARGETS.forEach((target, index) => expect(permits[index]?.actions).toEqual(GATEWAY_TOOLS[target].map((tool) => actionId(target, tool))));
    expect(allActionIds().every((id) => /^[a-z]+___[a-z_]+$/.test(id))).toBe(true);
    expect(new Set(allActionIds()).size).toBe(12);
  });

  it("parses as Cedar, with and without the kill switch", () => {
    for (const set of [policies, switchedOn]) {
      expect(cedar.checkParsePolicySet({ staticPolicies: Object.fromEntries(set.map((policy) => [policy.name, policy.statement])) })).toEqual({ type: "success" });
    }
  });
});

describe("engine limits and creation order", () => {
  it("keeps every statement under 10,000 characters once each action is qualified with the Gateway ARN", () => {
    const qualified = (statement: string): string => statement.replace(/AgentCore::Action::"/g, `AgentCore::Action::"${inputs.gatewayArn}/`);
    for (const policy of switchedOn) expect(qualified(policy.statement).length, policy.name).toBeLessThan(MAX_STATEMENT_CHARS);
  });

  it("creates the five permits first and every forbid after all of them", () => {
    for (const set of [policies, switchedOn]) {
      const plan = creationPlan(set);
      const permitNames = GATEWAY_TARGETS.map((target) => `CED_PERMIT_${target.toUpperCase()}`);
      expect(plan.slice(0, 5).map((step) => [step.definition.name, step.after])).toEqual(permitNames.map((name) => [name, []]));
      for (const step of plan.slice(5)) {
        expect(step.definition.effect).toBe("forbid");
        expect(step.after).toEqual(permitNames);
      }
      expect(plan.map((step) => step.definition.name).sort()).toEqual(set.map((policy) => policy.name).sort());
    }
  });

  it("scopes every forbid to the Harness, the only principal a permit allows", () => {
    for (const policy of switchedOn.filter((candidate) => candidate.effect === "forbid")) {
      expect(policy.statement).toContain(`forbid(\n  principal == AgentCore::IamEntity::"${inputs.harnessPrincipalId}",`);
    }
  });

  it("fails on analyzer findings except where the finding is certain by construction", () => {
    const certain = /^CED-(PERMIT|SESSION)-|^CED-KILL-SWITCH$/;
    for (const policy of switchedOn) expect(policy.validationMode, policy.id).toBe(certain.test(policy.id) ? "IGNORE_ALL_FINDINGS" : "FAIL_ON_ANY_FINDINGS");
  });
});

describe("cited fields: declared in the tool schema and read only behind `has`", () => {
  it("validates in strict mode against the schema of docs/tool-catalog.md; only the session forbids are impossible", () => {
    expect(validate(policies)).toEqual({ errors: [], warnings: GATEWAY_TARGETS.map((target) => `CED_SESSION_${target.toUpperCase()}`).sort() });
    expect(validate(switchedOn).errors).toEqual([]);
    expect(schemaProblems(switchedOn, catalog.schemas)).toEqual([]);
  });

  it.skipIf(generated === undefined)("validates against the Gateway schemas generated from zod (npm run tools:build-schemas)", () => {
    const payloads = Object.fromEntries(GATEWAY_TARGETS.map((target) => [target, generated?.[target].inlinePayload ?? []])) as Record<GatewayTarget, GatewayToolSchema[]>;
    const schemas = inputSchemasByAction(payloads);
    expect(Object.keys(schemas).sort()).toEqual(allActionIds().sort());
    expect(schemaProblems(switchedOn, schemas)).toEqual([]);
    expect(validate(switchedOn, cedarSchema(schemas)).errors).toEqual([]);
  });

  it("declares override, decision and force as optional fields documented as never set", () => {
    for (const [action, field, fence] of [
      ["evidence___update_checklist", "override", "CED-NO-OVERRIDE"],
      ["cases___escalate_case", "decision", "CED-NO-SUPERVISOR-DECISION"],
      ["cases___close_installation", "force", "CED-NO-FORCE-CLOSE"],
    ] as const) {
      const input = catalog.schemas[action];
      expect(input?.properties?.[field]?.description, action).toBe(`never set; denied by policy ${fence}`);
      expect(input?.required ?? [], action).not.toContain(field);
      expect(byId(fence).condition).toEqual({ kind: "when", terms: [{ kind: "has", field }] });
    }
  });

  it("reports a read without `has`, an undeclared field, a non-string comparison and a tool no permit names", () => {
    const guarded = byId("CED-WA-INSTALLER-ONLY");
    const bare = { ...guarded, condition: { kind: "unless" as const, terms: [{ kind: "eq" as const, field: "recipientRole", value: "INSTALLER" }] } };
    const whatsapp = catalog.schemas["messaging___send_whatsapp"]?.properties ?? {};
    const checklist = catalog.schemas["evidence___update_checklist"]?.properties ?? {};
    const broken: ToolInputSchemas = {
      ...catalog.schemas,
      evidence___update_checklist: { properties: Object.fromEntries(Object.entries(checklist).filter(([field]) => field !== "override")) },
      messaging___send_whatsapp: { properties: { ...whatsapp, recipientRole: { type: "object" } } },
      cases___close_case: { properties: { sessionToken: { type: "string" } } },
    };
    expect(schemaProblems([...policies.filter((policy) => policy !== guarded), bare], broken)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^CED-WA-INSTALLER-ONLY: context\.input\.recipientRole is read without/),
        expect.stringMatching(/^CED-NO-OVERRIDE: evidence___update_checklist declares no input field "override"/),
        expect.stringMatching(/^CED-WA-INSTALLER-ONLY: messaging___send_whatsapp\.recipientRole is compared with a string but is object/),
        "Gateway tool cases___close_case is named by no permit",
      ]),
    );
    // Cedar's own validator rejects a read of an optional field without `has`.
    const force = byId("CED-NO-FORCE-CLOSE");
    const unsafe = { ...force, statement: force.statement.replace("context.input has force", "context.input.force == true") };
    expect(validate([...policies.filter((policy) => policy !== force), unsafe]).errors).toEqual([expect.stringMatching(/^CED_NO_FORCE_CLOSE: .*optional attribute `input\.force`/)]);
  });

  it("shows why: a forbid that read an absent field without `has` would let the call through", () => {
    const guarded = byId("CED-WA-INSTALLER-ONLY");
    const bare = { ...guarded, statement: guarded.statement.replace("context.input has recipientRole &&\n  ", "") };
    const noRole = { sessionToken: SESSION, kind: "REPLY", text: "Listo" };
    expect(authorize(policies, "messaging___send_whatsapp", noRole, { validate: false })).toEqual({ decision: "deny", reasons: ["CED_WA_INSTALLER_ONLY"], errors: [] });
    const weakened = [...policies.filter((policy) => policy !== guarded), bare];
    expect(authorize(weakened, "messaging___send_whatsapp", noRole, { validate: false })).toEqual({ decision: "allow", reasons: ["CED_PERMIT_MESSAGING"], errors: ["CED_WA_INSTALLER_ONLY"] });
  });
});

describe("[FL-045] the agent cannot validate evidence by itself (CED-NO-OVERRIDE)", () => {
  it("denies update_checklist whenever `override` is present, whatever its value", () => {
    const base = { ...validInput("evidence___update_checklist"), item: "ONU_LABEL_PHOTO", status: "PASSED", validationId: "val-01" };
    for (const override of [true, false]) {
      expect(authorize(policies, "evidence___update_checklist", { ...base, override }), String(override)).toEqual({ decision: "deny", reasons: ["CED_NO_OVERRIDE"], errors: [] });
    }
    expect(authorize(policies, "evidence___update_checklist", { ...base, override: "yes" }, { validate: false }).reasons).toEqual(["CED_NO_OVERRIDE"]);
    expect(authorize(policies, "evidence___update_checklist", base).decision).toBe("allow");
  });

  it("offers no Gateway tool that validates by hand or decides for a supervisor (ADR-0011)", () => {
    expect(allActionIds().filter((id) => /___(override|approve|take|decline|decide|close_case|validate_evidence)/.test(id))).toEqual([]);
  });
});

describe("[FL-096] injected instructions cannot widen what a tool does", () => {
  it("sends WhatsApp only to the installer of the session (CED-WA-INSTALLER-ONLY)", () => {
    const base = validInput("messaging___send_whatsapp");
    for (const recipientRole of ["SUPERVISOR", "ZONE_CHIEF", "CUSTOMER", "installer", "INSTALLER "]) {
      expect(authorize(policies, "messaging___send_whatsapp", { ...base, recipientRole }), recipientRole).toEqual({ decision: "deny", reasons: ["CED_WA_INSTALLER_ONLY"], errors: [] });
    }
    expect(authorize(policies, "messaging___send_whatsapp", base).decision).toBe("allow");
  });

  it("never lets the agent decide a case (CED-NO-SUPERVISOR-DECISION) or force a close (CED-NO-FORCE-CLOSE)", () => {
    const escalate = validInput("cases___escalate_case");
    for (const decision of ["TAKE", "CLOSE", "DECLINE", ""]) {
      expect(authorize(policies, "cases___escalate_case", { ...escalate, decision }), decision).toEqual({ decision: "deny", reasons: ["CED_NO_SUPERVISOR_DECISION"], errors: [] });
    }
    expect(authorize(policies, "cases___escalate_case", escalate).decision).toBe("allow");
    const close = { ...validInput("cases___close_installation"), outcome: "INSTALLED" };
    for (const force of [true, false]) {
      expect(authorize(policies, "cases___close_installation", { ...close, force }), String(force)).toEqual({ decision: "deny", reasons: ["CED_NO_FORCE_CLOSE"], errors: [] });
    }
    expect(authorize(policies, "cases___close_installation", close).decision).toBe("allow");
  });

  it("denies every tool without a sessionToken (CED-SESSION-<TARGET>)", () => {
    for (const target of GATEWAY_TARGETS) {
      for (const tool of GATEWAY_TOOLS[target]) {
        const action = actionId(target, tool);
        const withoutSession = Object.fromEntries(Object.entries(validInput(action)).filter(([field]) => field !== "sessionToken"));
        const result = authorize(policies, action, withoutSession, { validate: false });
        expect(result.decision, action).toBe("deny");
        expect(result.reasons, action).toContain(`CED_SESSION_${target.toUpperCase()}`);
      }
    }
  });

  it("allows only the Harness, only on this Gateway, only the Gateway tools", () => {
    for (const action of allActionIds()) expect(authorize(policies, action, validInput(action)), action).toEqual({ decision: "allow", reasons: [`CED_PERMIT_${action.split("___")[0]?.toUpperCase()}`], errors: [] });
    const reply = validInput("messaging___send_whatsapp");
    expect(authorize(policies, "messaging___send_whatsapp", reply, { principal: assumedRoleEntityId(ACCOUNT, "some-other-role") }).decision).toBe("deny");
    expect(authorize(policies, "messaging___send_whatsapp", reply, { resource: `${inputs.gatewayArn}-other` }).decision).toBe("deny");
    expect(authorize(policies, "cases___close_case", { sessionToken: SESSION }, { validate: false })).toEqual({ decision: "deny", reasons: [], errors: [] });
  });
});

describe("[FL-100] kill switch (CED-KILL-SWITCH), the second layer of the emergency stop", () => {
  it("is off by default: absent, so it denies nothing", () => {
    expect(KILL_SWITCH_ACTIVE).toBe(false);
    expect(policies.some((policy) => policy.id === "CED-KILL-SWITCH")).toBe(false);
    for (const action of allActionIds()) expect(authorize(policies, action, validInput(action)).decision, action).toBe("allow");
  });

  it("denies every Gateway tool of the Harness once switched on through IaC, report_safety_hazard included", () => {
    const killSwitch = byId("CED-KILL-SWITCH", switchedOn);
    expect(killSwitch).toMatchObject({ name: "CED_KILL_SWITCH", effect: "forbid", actions: allActionIds() });
    expect(killSwitch.condition).toBeUndefined();
    expect(killSwitch.statement.endsWith(`resource == AgentCore::Gateway::"${inputs.gatewayArn}"\n);`)).toBe(true);
    for (const action of allActionIds()) {
      const result = authorize(switchedOn, action, validInput(action));
      expect(result.decision, action).toBe("deny");
      expect(result.reasons, action).toContain("CED_KILL_SWITCH");
    }
  });
});
