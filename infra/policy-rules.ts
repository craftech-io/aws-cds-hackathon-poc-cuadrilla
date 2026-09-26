// Cedar policies of the AgentCore Policy engine (docs/design-brief.md §5.6, docs/architecture.md §9.2,
// docs/build-plan.md WP-08), as plain data: the `CED-*` statements, the checks they must pass against
// the Gateway tool schemas, and the Cedar schema those tool schemas imply (for the local evaluator of
// the tests and of the scripted Harness of the local flows, @cedar-policy/cedar-wasm; the Gateway
// evaluates the real thing).
//
// What Cedar sees on an AWS_IAM Gateway:
//   principal  AgentCore::IamEntity "arn:aws:sts::<account>:assumed-role/<role>", the Harness execution
//              role, the Gateway's only caller
//   action     AgentCore::Action "<target>___<tool>", one per Gateway tool
//   resource   AgentCore::Gateway "<gatewayArn>"
//   context    only `context.input`, the tool arguments typed from the tool's JSON schema (string →
//              String, integer → Long, number → decimal, boolean → Boolean, array → Set, object →
//              Record); a property outside `required` is an optional attribute
// Cedar is default-deny and forbid-wins. Whatever depends on the session (scope, recipient, evidence,
// bridge, kill switch in runtime) is checked by the target Lambdas (`LAM-*`); Cedar holds the static
// fences, and none of them can give the agent a power the tools do not have (ADR-0011).
//
// What the engine imposes (docs/architecture.md §9.2 and §16):
//   - a statement may not exceed 10,000 characters once each action is qualified with the Gateway, so
//     the permit and the session forbid are one policy per target;
//   - automated reasoning checks the whole engine: a forbid created while no permit covers its action is
//     "Overly Restrictive", so the permits are created first and every forbid depends on all of them
//     (`creationPlan`, applied by infra/policy.ts);
//   - a policy name another engine of the account already holds is refused (ConflictException "Policy
//     with the same name already exists", although this engine lists no such policy), and the account
//     is shared with another app, so the name in the engine carries the app and the stage
//     (`enginePolicyName`);
//   - each statement is validated against the Gateway's tool schemas, so every field it cites must be
//     declared there (`schemaProblems`, run by infra/policy.ts on the generated schemas before creating);
//   - reading an absent field is an evaluation error and Cedar skips an erroring policy: a forbid that
//     read a field without `context.input has <field>` first would fall through to the permit.
//
// No SST dependency: policy-rules.test.ts checks all of this without an AWS account.

/** Gateway targets in chain order; each `GatewayTarget` of infra/agent-tools.ts must be named exactly like this. */
export const GATEWAY_TARGETS = ["orders", "knowledge", "evidence", "messaging", "cases"] as const;
export type GatewayTarget = (typeof GATEWAY_TARGETS)[number];

/** The 12 Gateway tools per target (docs/tool-catalog.md). Direct-invocation handlers are not Gateway actions. */
export const GATEWAY_TOOLS: Readonly<Record<GatewayTarget, readonly string[]>> = {
  orders: ["get_work_orders", "get_work_order", "get_onu_status"],
  knowledge: ["search_procedures"],
  evidence: ["get_checklist", "validate_install_photo", "update_checklist"],
  messaging: ["send_whatsapp"],
  cases: ["record_troubleshooting_step", "escalate_case", "report_safety_hazard", "close_installation"],
};

/** Cedar action id of a Gateway tool: `<target>___<tool>`, the name the Gateway gives it. */
export function actionId(target: GatewayTarget, tool: string): string {
  return `${target}___${tool}`;
}

/** Every Gateway action id, in target order. */
export function allActionIds(): string[] {
  return GATEWAY_TARGETS.flatMap((target) => GATEWAY_TOOLS[target].map((tool) => actionId(target, tool)));
}

const upper = (target: GatewayTarget): Uppercase<GatewayTarget> => target.toUpperCase() as Uppercase<GatewayTarget>;

export type CedarStatementId =
  | `CED-PERMIT-${Uppercase<GatewayTarget>}`
  | `CED-SESSION-${Uppercase<GatewayTarget>}`
  | "CED-WA-INSTALLER-ONLY"
  | "CED-NO-OVERRIDE"
  | "CED-NO-SUPERVISOR-DECISION"
  | "CED-NO-FORCE-CLOSE"
  | "CED-KILL-SWITCH";

/** Every statement id, in creation order (docs/design-brief.md §5.6); CED-KILL-SWITCH exists only while active. */
export const CEDAR_STATEMENT_IDS: readonly CedarStatementId[] = [
  ...GATEWAY_TARGETS.map((target): CedarStatementId => `CED-PERMIT-${upper(target)}`),
  ...GATEWAY_TARGETS.map((target): CedarStatementId => `CED-SESSION-${upper(target)}`),
  "CED-WA-INSTALLER-ONLY",
  "CED-NO-OVERRIDE",
  "CED-NO-SUPERVISOR-DECISION",
  "CED-NO-FORCE-CLOSE",
  "CED-KILL-SWITCH",
];

/**
 * CED-KILL-SWITCH, the second layer of the emergency stop (ADR-0019; the first is `Runtime/KILL#`, read
 * in runtime with no deploy). While `false` the policy does not exist; switching it on is an IaC change
 * (this constant to `true`, through CI) that creates an unconditional forbid on every Gateway tool of
 * the Harness. Never a console action. Physical safety keeps working: the classifier and `handle_safety`
 * are invoked directly, not through the Gateway.
 */
export const KILL_SWITCH_ACTIVE = false;

/** Engine limit per statement, once every action is qualified with the Gateway ARN. */
export const MAX_STATEMENT_CHARS = 10_000;

export type CedarEffect = "permit" | "forbid";
/** Whether a policy takes part in the decision (`ACTIVE`) or is only traced (`LOG_ONLY`). */
export type CedarEnforcementMode = "ACTIVE" | "LOG_ONLY";
/** How the engine treats automated-reasoning findings when the policy is created or updated. */
export type CedarValidationMode = "FAIL_ON_ANY_FINDINGS" | "IGNORE_ALL_FINDINGS";

/** The only Cedar terms the statements use: presence of a field and equality with a string. */
export type CedarTerm = { readonly kind: "has"; readonly field: string } | { readonly kind: "eq"; readonly field: string; readonly value: string };

export interface CedarCondition {
  readonly kind: "when" | "unless";
  /** Joined with `&&`, evaluated left to right with short-circuit. */
  readonly terms: readonly CedarTerm[];
}

export interface CedarPolicyDefinition {
  readonly id: CedarStatementId;
  /** Statement name (`CED_NO_OVERRIDE`), unique; the engine gets it inside `enginePolicyName`. */
  readonly name: string;
  readonly effect: CedarEffect;
  /** Gateway action ids the statement covers. */
  readonly actions: readonly string[];
  readonly condition?: CedarCondition;
  readonly description: string;
  readonly statement: string;
  readonly enforcementMode: CedarEnforcementMode;
  readonly validationMode: CedarValidationMode;
}

export interface CedarPolicyInputs {
  /** ARN of the Gateway the policies protect. */
  readonly gatewayArn: string;
  /** Cedar entity id of the Harness execution role (`assumedRoleEntityId`). */
  readonly harnessPrincipalId: string;
}

export interface CedarPolicyOptions {
  readonly killSwitchActive?: boolean;
}

/** Entity types of the AgentCore Cedar namespace. */
export const CEDAR_TYPES = {
  principal: "AgentCore::IamEntity",
  action: "AgentCore::Action",
  resource: "AgentCore::Gateway",
} as const;

/** Entity id Cedar gives an assumed IAM role, stable across session names. */
export function assumedRoleEntityId(accountId: string, roleName: string): string {
  return `arn:aws:sts::${accountId}:assumed-role/${roleName}`;
}

/** `CED-NO-OVERRIDE` → `CED_NO_OVERRIDE`, the only characters a Policy name accepts. */
export function policyName(id: CedarStatementId): string {
  return id.replace(/-/g, "_");
}

/** Longest name the engine accepts for itself and for each policy, both `^[A-Za-z][A-Za-z0-9_]*$`. */
export const MAX_ENGINE_NAME_CHARS = 48;

/** Name of the engine: `^[A-Za-z][A-Za-z0-9_]*$`, at most 48 characters. */
export function policyEngineName(app: string, stage: string): string {
  return `${app}_${stage}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, MAX_ENGINE_NAME_CHARS);
}

/**
 * Name of a policy in the engine, `<last word of the app>_<stage>_<statement name>`
 * (`cuadrilla_poc_CED_NO_OVERRIDE`): policy names are unique across the engines of the account, not
 * per engine, and another app shares the account. The namespace is cut so the name fits in 48 characters.
 */
export function enginePolicyName(app: string, stage: string, name: string): string {
  const words = app.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  const namespace = `${words[words.length - 1] ?? app}_${stage}`.replace(/[^A-Za-z0-9_]/g, "_");
  return `${namespace.slice(0, Math.max(0, MAX_ENGINE_NAME_CHARS - name.length - 1))}_${name}`;
}

// ---- Rendering ---------------------------------------------------------------------------------

const has = (field: string): CedarTerm => ({ kind: "has", field });
const eq = (field: string, value: string): CedarTerm => ({ kind: "eq", field, value });

function renderTerm(term: CedarTerm): string {
  return term.kind === "has" ? `context.input has ${term.field}` : `context.input.${term.field} == "${term.value}"`;
}

function renderActions(actions: readonly string[]): string {
  const [only] = actions;
  if (actions.length === 1 && only !== undefined) return `action == ${CEDAR_TYPES.action}::"${only}"`;
  return `action in [\n${actions.map((action) => `    ${CEDAR_TYPES.action}::"${action}"`).join(",\n")}\n  ]`;
}

function render(id: CedarStatementId, effect: CedarEffect, inputs: CedarPolicyInputs, actions: readonly string[], condition?: CedarCondition): string {
  const scope = `principal == ${CEDAR_TYPES.principal}::"${inputs.harnessPrincipalId}",\n  ${renderActions(actions)},\n  resource == ${CEDAR_TYPES.resource}::"${inputs.gatewayArn}"`;
  const body = condition === undefined ? "" : `\n${condition.kind} {\n  ${condition.terms.map(renderTerm).join(" &&\n  ")}\n}`;
  return `// ${id}\n${effect}(\n  ${scope}\n)${body};`;
}

/**
 * The Cedar policies, permits first. Every statement is scoped to the Gateway ARN (so the engine
 * validates it against that Gateway's schemas) and every forbid names the Harness principal: it is the
 * only principal a permit allows, so the scope changes no decision, and the analyzer does not check
 * principal types that no permit covers. Every field a forbid reads is guarded by `has` first, even a
 * required one: a schema that loses the field must not turn the forbid into an evaluation error.
 */
export function cedarPolicies(inputs: CedarPolicyInputs, options: CedarPolicyOptions = {}): CedarPolicyDefinition[] {
  const policy = (
    id: CedarStatementId,
    effect: CedarEffect,
    actions: readonly string[],
    description: string,
    validationMode: CedarValidationMode,
    condition?: CedarCondition,
  ): CedarPolicyDefinition => ({
    id,
    name: policyName(id),
    effect,
    actions,
    ...(condition === undefined ? {} : { condition }),
    description,
    statement: render(id, effect, inputs, actions, condition),
    enforcementMode: "ACTIVE",
    validationMode,
  });
  const targetActions = (target: GatewayTarget) => GATEWAY_TOOLS[target].map((tool) => actionId(target, tool));

  const permits = GATEWAY_TARGETS.map((target) =>
    // An unconditional allowlist reads "overly permissive" until the forbids that narrow it exist, and
    // those need it first. Schema validation still runs; the fences fail on any finding.
    policy(`CED-PERMIT-${upper(target)}`, "permit", targetActions(target), `Only the Harness role may call the ${target} tools, and only these; anything else falls to default deny.`, "IGNORE_ALL_FINDINGS"),
  );
  const sessions = GATEWAY_TARGETS.map((target) =>
    // Every Gateway schema requires sessionToken, so the analyzer may call this forbid ineffective; it
    // stays as defense in depth should a schema ever lose the field.
    policy(`CED-SESSION-${upper(target)}`, "forbid", targetActions(target), `A ${target} tool call must carry the signed sessionToken; identity never comes from what the model writes.`, "IGNORE_ALL_FINDINGS", {
      kind: "unless",
      terms: [has("sessionToken")],
    }),
  );
  const fences = [
    policy("CED-WA-INSTALLER-ONLY", "forbid", [actionId("messaging", "send_whatsapp")], "send_whatsapp only ever goes to the installer of the session; the agent never writes to a supervisor.", "FAIL_ON_ANY_FINDINGS", {
      kind: "unless",
      terms: [has("recipientRole"), eq("recipientRole", "INSTALLER")],
    }),
    policy("CED-NO-OVERRIDE", "forbid", [actionId("evidence", "update_checklist")], "The agent never validates evidence by hand: update_checklist with `override` is denied, whatever its value (ADR-0011).", "FAIL_ON_ANY_FINDINGS", {
      kind: "when",
      terms: [has("override")],
    }),
    policy("CED-NO-SUPERVISOR-DECISION", "forbid", [actionId("cases", "escalate_case")], "The agent opens cases and never takes, declines or closes one: escalate_case with `decision` is denied (ADR-0011).", "FAIL_ON_ANY_FINDINGS", {
      kind: "when",
      terms: [has("decision")],
    }),
    policy("CED-NO-FORCE-CLOSE", "forbid", [actionId("cases", "close_installation")], "close_installation with `force` is denied: an installation closes only with complete evidence (ADR-0011).", "FAIL_ON_ANY_FINDINGS", {
      kind: "when",
      terms: [has("force")],
    }),
  ];
  const killSwitch = (options.killSwitchActive ?? KILL_SWITCH_ACTIVE)
    ? [
        // An unconditional forbid reads "always deny" to the analyzer; that is the point.
        policy("CED-KILL-SWITCH", "forbid", allActionIds(), "Kill switch ACTIVE (infra/policy-rules.ts): every Gateway call of the Harness is denied (ADR-0019, second layer).", "IGNORE_ALL_FINDINGS"),
      ]
    : [];
  return [...permits, ...sessions, ...fences, ...killSwitch];
}

export interface PolicyCreationStep {
  readonly definition: CedarPolicyDefinition;
  /** Names of the policies this one must be created after. */
  readonly after: readonly string[];
}

/**
 * Permits first, every forbid after all the permits, and one policy at a time: the analyzer checks each
 * new policy against those already in the engine, so each step also waits for the one before it and
 * that set never depends on which concurrent create lands first.
 */
export function creationPlan(policies: readonly CedarPolicyDefinition[]): PolicyCreationStep[] {
  const permits = policies.filter((policy) => policy.effect === "permit");
  const forbids = policies.filter((policy) => policy.effect === "forbid");
  const permitNames = permits.map((policy) => policy.name);
  const previous = (list: readonly CedarPolicyDefinition[], index: number): string[] => (index === 0 ? [] : [list[index - 1]?.name ?? ""]);
  return [
    ...permits.map((definition, index) => ({ definition, after: previous(permits, index) })),
    ...forbids.map((definition, index) => ({ definition, after: [...permitNames, ...previous(forbids, index)] })),
  ];
}

// ---- Tool schemas: static checks and the Cedar schema they imply ---------------------------------

/** The subset of JSON Schema the Gateway accepts (docs/tool-catalog.md, "Schemas del Gateway"). */
export interface JsonSchemaNode {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchemaNode;
}

/** Input schema of every Gateway action, keyed by action id (`<target>___<tool>`). */
export type ToolInputSchemas = Readonly<Record<string, JsonSchemaNode>>;

/** One entry of a target's `inlinePayload`, as far as Cedar cares. */
export interface GatewayToolSchema {
  readonly name: string;
  readonly inputSchema: JsonSchemaNode;
}

export function inputSchemasByAction(payloads: Readonly<Record<GatewayTarget, readonly GatewayToolSchema[]>>): ToolInputSchemas {
  const schemas: Record<string, JsonSchemaNode> = {};
  for (const target of GATEWAY_TARGETS) for (const tool of payloads[target]) schemas[actionId(target, tool.name)] = tool.inputSchema;
  return schemas;
}

/**
 * Everything the engine would reject or that would silently weaken a fence: a read without an earlier
 * `has` of the same field, an action without a Gateway schema, a cited field the schema does not
 * declare, a string comparison on a field that is not a string, and a Gateway tool no permit names.
 */
export function schemaProblems(policies: readonly CedarPolicyDefinition[], schemas: ToolInputSchemas): string[] {
  const problems: string[] = [];
  const permitted = new Set<string>();
  for (const policy of policies) {
    if (policy.effect === "permit") for (const action of policy.actions) permitted.add(action);
    const guarded = new Set<string>();
    for (const term of policy.condition?.terms ?? []) {
      if (term.kind === "has") guarded.add(term.field);
      else if (!guarded.has(term.field)) problems.push(`${policy.id}: context.input.${term.field} is read without "context.input has ${term.field}" first`);
    }
    for (const action of policy.actions) {
      const properties = schemas[action]?.properties;
      if (properties === undefined) {
        problems.push(`${policy.id}: no Gateway input schema for ${action}`);
        continue;
      }
      for (const term of policy.condition?.terms ?? []) {
        const property = properties[term.field];
        if (property === undefined) problems.push(`${policy.id}: ${action} declares no input field "${term.field}"`);
        else if (term.kind === "eq" && property.type !== "string") problems.push(`${policy.id}: ${action}.${term.field} is compared with a string but is ${property.type ?? "untyped"}`);
      }
    }
  }
  for (const action of Object.keys(schemas)) if (!permitted.has(action)) problems.push(`Gateway tool ${action} is named by no permit`);
  return problems;
}

export type CedarType =
  | { readonly type: "String" }
  | { readonly type: "Long" }
  | { readonly type: "Boolean" }
  | { readonly type: "Extension"; readonly name: "decimal" }
  | { readonly type: "Set"; readonly element: CedarType }
  | { readonly type: "Record"; readonly attributes: Readonly<Record<string, CedarAttribute>>; readonly additionalAttributes: false };

export type CedarAttribute = CedarType & { readonly required: boolean };

export interface CedarNamespace {
  readonly entityTypes: Record<string, Record<string, never>>;
  readonly actions: Record<string, { readonly appliesTo: { principalTypes: string[]; resourceTypes: string[]; readonly context: CedarType } }>;
}

/** Cedar schema (JSON form, the shape @cedar-policy/cedar-wasm takes): namespace name → definition. */
export type CedarSchemaJson = Record<string, CedarNamespace>;

function cedarType(node: JsonSchemaNode, path: string): CedarType {
  switch (node.type) {
    case "string":
      return { type: "String" };
    case "integer":
      return { type: "Long" };
    case "number":
      return { type: "Extension", name: "decimal" };
    case "boolean":
      return { type: "Boolean" };
    case "array":
      if (node.items === undefined) throw new Error(`${path}: an array needs "items"`);
      return { type: "Set", element: cedarType(node.items, `${path}[]`) };
    case "object":
      return record(node, path);
    default:
      throw new Error(`${path}: unsupported type "${node.type ?? "none"}"`);
  }
}

function record(node: JsonSchemaNode, path: string): CedarType {
  const required = new Set(node.required ?? []);
  const attributes = Object.fromEntries(
    Object.entries(node.properties ?? {}).map(([name, child]): [string, CedarAttribute] => [name, { ...cedarType(child, `${path}.${name}`), required: required.has(name) }]),
  );
  return { type: "Record", attributes, additionalAttributes: false };
}

/** The schema the engine derives from the Gateway: one action per tool, `context.input` typed from its input schema. */
export function cedarSchema(schemas: ToolInputSchemas): CedarSchemaJson {
  const actions = Object.fromEntries(
    Object.entries(schemas).map(([action, input]) => [
      action,
      {
        appliesTo: {
          principalTypes: ["IamEntity"],
          resourceTypes: ["Gateway"],
          context: { type: "Record" as const, attributes: { input: { ...record(input, action), required: true } }, additionalAttributes: false as const },
        },
      },
    ]),
  );
  return { AgentCore: { entityTypes: { IamEntity: {}, Gateway: {} }, actions } };
}
