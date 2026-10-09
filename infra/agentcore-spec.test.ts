// The agent as data (infra/agentcore-spec.ts and the policy builders of infra/agentcore-iam.ts,
// docs/build-plan.md WP-26): names, limits and Memory against docs/architecture.md §4, §9 and §12, the tool
// Lambdas against infra/iam-capabilities.ts, the Gateway payloads against the Cedar statements, the three
// roles against §14 and the permissions boundary of the CI bootstrap, and the service facts the spec records
// against the pinned provider and the installed SDK. No AWS account.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../packages/bff/src/agent/system-prompt";
import { TOOL_TARGETS } from "../packages/bff/src/agent-tools/common/definition";
import { DEFAULT_OPERATOR_NAME } from "../packages/bff/src/copy/brand";
import { MASK_MARKERS } from "../packages/bff/src/lib/mask";
import { gatewayToolSchemas } from "./agent-tool-schemas";
import { AGENT_ROLE_WILDCARD_SIDS, agentCoreTrustPolicy, agentRoleStatements, capabilityStatements, modelRefArns, policyDocument, trustSourcePattern, type AgentRole, type AgentStatement } from "./agentcore-iam";
import * as spec from "./agentcore-spec";
import { boundaryAllows, template } from "./bootstrap/template-text";
import { CAPABILITIES, LAMBDA_CAPABILITIES, SERVICE_ROLES, agentModelArns, expectedGrants, resolveCapabilities, type Grant, type LambdaName, type RoleName } from "./iam-capabilities";
import { GATEWAY_TARGETS, GATEWAY_TOOLS, actionId, cedarPolicies, inputSchemasByAction, schemaProblems, type GatewayTarget } from "./policy-rules";

const APP = "aws-cds-hackathon-poc-cuadrilla";
const STAGE = "poc";
const PLACE = { account: "776805327629", region: "us-east-1" };
/** The app's inference profile as Bedrock names it once created (ADR-0028). */
const PROFILE = "arn:aws:bedrock:us-east-1:776805327629:application-inference-profile/ab12cd34ef56";
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

const architecture = read("docs/architecture.md");
const section = (from: string, to: string): string => architecture.slice(architecture.indexOf(from), architecture.indexOf(to));
const accountSection = section("## 1.", "## 2.");
const components = section("## 4.", "## 5.");
const gatewaySection = section("### 9.2", "### 9.3");
const memorySection = section("### 9.3", "### 9.4");
const observability = section("## 12.", "## 13.");

/** The number written right after `label` in a docs section (`maxIterations 10` → 10). */
function documented(text: string, label: string): number {
  const match = new RegExp(`${label} (\\d+)`).exec(text);
  if (match?.[1] === undefined) throw new Error(`docs/architecture.md does not state "${label} <n>"`);
  return Number(match[1]);
}

/** Field names of an interface of a declaration file, at any nesting level. */
function interfaceFields(path: string, name: string): string[] {
  const text = read(path);
  const start = text.search(new RegExp(`^( *)(export )?interface ${name} \\{`, "m"));
  if (start < 0) throw new Error(`${path} has no interface ${name}`);
  const indent = /^ */.exec(text.slice(start))?.[0] ?? "";
  const body = text.slice(start, text.indexOf(`\n${indent}}`, start));
  return [...body.matchAll(new RegExp(`^${indent} {4}([A-Za-z]+)\\??:`, "gm"))].map((match) => match[1] ?? "");
}

/** Field names of every file#Interface a record lists. */
const recordedFields = (checked: readonly string[]): string[] =>
  checked.flatMap((entry) => {
    const [file = "", name = ""] = entry.split("#");
    return interfaceFields(file, name);
  });

/** IAM glob (`*` only) of a pattern against a value (itself possibly a pattern). */
function covers(pattern: string, value: string): boolean {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`).test(value);
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const ROLES = [...Object.keys(LAMBDA_CAPABILITIES), ...Object.keys(SERVICE_ROLES)] as RoleName[];
const TOOL_FUNCTIONS = Object.values(spec.TOOL_FUNCTIONS);

describe("names (docs/architecture.md §1 and §9)", () => {
  it("fit the service patterns and the fixed names of the architecture", () => {
    expect(spec.harnessName(APP, STAGE)).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
    expect(spec.memoryName(APP, STAGE)).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    expect(memorySection).toContain(`\`${spec.memoryName(APP, STAGE)}\``);
    expect(spec.gatewayName(APP, STAGE)).toMatch(/^([0-9a-zA-Z][-]?){1,48}$/);
    expect(gatewaySection).toContain(`Gateway \`${spec.gatewayName(APP, STAGE)}\``);
    expect(gatewaySection).toContain(`herramienta del Harness \`${spec.GATEWAY_TOOL_NAME}\``);
    expect(spec.GATEWAY_TOOL_NAME).toMatch(TOOL_NAME);
    expect(spec.HARNESS_ENDPOINT_NAME).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
    for (const purpose of ["harness", "gateway", "memory"] as const) expect(spec.agentRoleName(APP, STAGE, purpose).length).toBeLessThanOrEqual(64);
  });

  it("keeps the runtime under the Harness inside the fence of the CI bootstrap (harness_<AgentNamePrefix>*)", () => {
    const prefix = /AgentNamePrefix:\n\s+Type: String\n\s+Default: (\S+)/.exec(template)?.[1] ?? "?";
    expect(covers(`harness_${prefix}*`, `harness_${spec.harnessName(APP, STAGE)}-Ab12Cd34Ef`)).toBe(true);
  });
});

describe("Harness (docs/architecture.md §4, ADR-0020)", () => {
  it("uses the documented models, limits and tools", () => {
    expect(accountSection).toContain(`Harness, Memory y validación de fotos: \`${spec.HARNESS_MODEL_ID}\``);
    expect(spec.PHOTO_MODEL_ID).toBe(spec.HARNESS_MODEL_ID);
    expect(components).toContain(`\`${spec.HARNESS_API_FORMAT}\``);
    const limits = { maxIterations: "maxIterations", maxTokens: "maxTokens", timeoutSeconds: "timeoutSeconds", slidingWindowMessages: "sliding_window" } as const;
    expect(spec.HARNESS_LIMITS).toEqual(Object.fromEntries(Object.entries(limits).map(([key, label]) => [key, documented(components, label)])));
    expect(spec.HARNESS_LIMITS.maxTokens).toBeGreaterThanOrEqual(4096);
    expect(components).toContain(`allowedTools: [${spec.HARNESS_ALLOWED_TOOLS.map((tool) => `"${tool}"`).join(", ")}]`);
  });

  it("allows the Gateway only: no built-in shell, file or code interpreter tool", () => {
    expect(spec.HARNESS_ALLOWED_TOOLS).toEqual([`@${spec.GATEWAY_TOOL_NAME}/*`]);
    for (const pattern of spec.HARNESS_ALLOWED_TOOLS) expect(pattern).not.toMatch(/^\*$|builtin|shell|file|code/);
  });

  it("keeps the session lifecycle inside the service range and above one turn", () => {
    for (const value of Object.values(spec.HARNESS_LIFECYCLE)) expect(value >= 60 && value <= 28_800, String(value)).toBe(true);
    expect(spec.HARNESS_LIFECYCLE.idleRuntimeSessionTimeoutSeconds).toBeGreaterThan(spec.HARNESS_LIMITS.timeoutSeconds);
  });

  it("puts G1 in the model parameters of the app's inference profile, over streaming Converse", () => {
    const guardrail = { guardrailConfig: { guardrailIdentifier: "g1", guardrailVersion: "1", trace: "enabled" } };
    expect(spec.harnessBedrockModelConfig(PROFILE, guardrail)).toEqual({ modelId: PROFILE, apiFormat: "converse_stream", additionalParams: guardrail });
    expect(read("infra/agentcore.ts")).toContain("harnessBedrockModelConfig(modelProfile.arn, harnessGuardrailConfig)");
  });

  it("records that the Harness exposes no effort, as the pinned provider and the installed SDK declare it", () => {
    const fields = recordedFields(spec.HARNESS_EFFORT.checked);
    expect(fields).toEqual(expect.arrayContaining(["maxTokens", "additionalParams"]));
    expect(fields.filter((field) => /effort|reasoning|thinking/i.test(field))).toEqual([]);
    expect(spec.HARNESS_EFFORT).toMatchObject({ exposed: false, effort: undefined });
  });

  it("tags the static system prompt, which names the untrusted block by the envelope header", () => {
    expect(SYSTEM_PROMPT).toContain('delim="…"');
    expect(spec.textDigest(SYSTEM_PROMPT)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("Memory (docs/architecture.md §9.3, docs/design-brief.md §5.4)", () => {
  const rows = [...memorySection.matchAll(/^\| [^|]+ \| `(\w+)` \| `([^`]+)` \|/gm)].map((match) => [match[1], match[2]]);
  const strategies = spec.memoryStrategyArgs(PROFILE).map((entry) => entry.customMemoryStrategy);
  const prompts = strategies.flatMap((strategy) => Object.values(strategy.configuration).flatMap((override: object) => Object.values(override) as Array<{ appendToPrompt: string; modelId: string }>));

  it("has exactly the three documented strategies, names, namespaces and event expiry", () => {
    expect(rows).toHaveLength(3);
    expect(Object.entries(spec.MEMORY_STRATEGIES).map(([name, strategy]) => [name, strategy.namespace])).toEqual(rows);
    for (const name of Object.keys(spec.MEMORY_STRATEGIES)) expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/);
    expect(spec.MEMORY_EVENT_EXPIRY_DAYS).toBe(documented(memorySection, "eventExpiryDuration"));
    expect(spec.MEMORY_EVENT_EXPIRY_DAYS).toBeGreaterThanOrEqual(3);
    expect(spec.MEMORY_EVENT_EXPIRY_DAYS).toBeLessThanOrEqual(365);
  });

  it("retrieves tips and preferences with topK 5 and the summary with topK 3, per installer actor", () => {
    expect(memorySection).toContain("consejos y preferencias `topK 5`; resumen `topK 3`");
    const config = spec.memoryRetrievalConfig();
    expect(Object.keys(config)).toEqual(Object.values(spec.MEMORY_STRATEGIES).map((strategy) => strategy.namespace));
    expect(Object.values(config).map((entry) => entry.topK)).toEqual([5, 5, 3]);
    for (const namespace of Object.keys(config)) expect(namespace).toMatch(/^\/installers\/\{actorId\}\/([a-zA-Z0-9\-_/]|\{sessionId\})*$/);
  });

  it("overrides every prompt of the three custom strategies with its focus, the exclusion rules and the extraction model", () => {
    expect(strategies.map((strategy) => strategy.name)).toEqual(Object.keys(spec.MEMORY_STRATEGIES));
    expect(strategies.map((strategy) => Object.keys(strategy.configuration))).toEqual([["semanticOverride"], ["userPreferenceOverride"], ["summaryOverride"]]);
    expect(prompts).toHaveLength(5);
    expect(read("infra/agentcore.ts")).toContain("memoryStrategies: modelProfile.arn.apply(memoryStrategyArgs)");
    for (const prompt of prompts) expect([prompt.modelId, prompt.appendToPrompt.endsWith(spec.MEMORY_EXCLUSION_INSTRUCTION)]).toEqual([PROFILE, true]);
    for (const strategy of strategies) expect(strategy.namespaceTemplates).toHaveLength(1);
  });

  it("keeps customer data, identifiers, secrets, inbound instructions and masked markers out of long-term memory", () => {
    for (const term of ["customer", "addresses", "phone numbers", "CURP", "RFC", "INE", "CLABE", "card numbers", "passwords", "session tokens", "instructions", ...Object.values(MASK_MARKERS)]) {
      expect(spec.MEMORY_EXCLUSION_INSTRUCTION, term).toContain(term);
    }
    expect(spec.MEMORY_STRATEGIES.installerTips.focus).toMatch(/recurring mistakes.*what resolved/);
    for (const prompt of prompts) expect(prompt.appendToPrompt).not.toContain(DEFAULT_OPERATOR_NAME);
  });
});

describe("tool Lambdas (docs/architecture.md §9.2, §12 and §14)", () => {
  it("run one Lambda per target, each an entry of infra/iam-capabilities.ts over the wrapper of WP-25", () => {
    expect([...GATEWAY_TARGETS]).toEqual([...TOOL_TARGETS]);
    expect(Object.keys(spec.TOOL_FUNCTIONS)).toEqual([...GATEWAY_TARGETS]);
    expect(Object.keys(LAMBDA_CAPABILITIES).filter((fn) => fn.startsWith("Tool")).sort()).toEqual([...TOOL_FUNCTIONS].sort());
    for (const target of GATEWAY_TARGETS) {
      const [file = "", exported = ""] = spec.toolHandlerPath(target).split(/\.(?=handler$)/);
      expect(existsSync(resolve(process.cwd(), `${file}.ts`)), target).toBe(true);
      expect(read(`${file}.ts`)).toContain(`export const ${exported} = `);
    }
  });

  it("budgets every target below two thirds of a Harness turn, with the reserved concurrency of §12", () => {
    for (const [target, lambda] of Object.entries(spec.TOOL_LAMBDAS)) {
      expect(lambda.timeoutSeconds, target).toBeGreaterThan(0);
      expect(lambda.timeoutSeconds, target).toBeLessThanOrEqual((spec.HARNESS_LIMITS.timeoutSeconds * 2) / 3);
      expect(lambda.memoryMb, target).toBeGreaterThanOrEqual(128);
    }
    expect(spec.TOOL_LAMBDAS.evidence.reservedConcurrency).toBe(documented(observability, "`ToolEvidence`"));
    expect(Object.values(spec.TOOL_LAMBDAS).filter((lambda) => lambda.reservedConcurrency !== undefined)).toHaveLength(1);
  });

  it("carries every grant of every target, and nothing a tool may not hold", () => {
    expect(Object.fromEntries(TOOL_FUNCTIONS.map((fn) => [fn, spec.toolCarriers(fn)]))).toEqual({
      ToolOrders: ["EmailChannel", "Guardrails", "NetworkMock", "Scheduler", "StoragePrefix", "WhatsAppNumber"],
      ToolKnowledge: ["KnowledgeBase"],
      ToolEvidence: ["EmailChannel", "Guardrails", "NetworkMock", "PhotoModel", "Scheduler", "StoragePrefix", "WhatsAppNumber"],
      ToolMessaging: ["EmailChannel", "Guardrails", "Scheduler", "StoragePrefix", "WhatsAppNumber"],
      ToolCases: ["CertificateWriter", "EmailChannel", "Guardrails", "NetworkMock", "Scheduler", "StoragePrefix", "WhatsAppNumber"],
    });
    expect(() => spec.toolCarriers("InstallerWorker")).toThrow(/No tool Lambda may hold/);
    expect(() => spec.toolGrantCarrier({ actions: ["s3:GetObject"], resources: ["{Seed}"] })).toThrow();
  });

  it("gives each capability Linkable exactly the grants of its capability", () => {
    const byCarrier = (fn: LambdaName, carrier: spec.ToolCarrier): Grant[] => expectedGrants(fn).filter((grant) => spec.toolGrantCarrier(grant) === carrier);
    const capabilityOf = { NetworkMock: "MOCK_NETWORK", Guardrails: "PIPELINE", EmailChannel: "SEND_EMAIL", Scheduler: "TIMERS" } as const;
    for (const fn of TOOL_FUNCTIONS) {
      for (const [carrier, capability] of Object.entries(capabilityOf)) {
        if (spec.toolCarriers(fn).includes(carrier as spec.ToolCarrier)) expect(byCarrier(fn, carrier as spec.ToolCarrier), `${fn} ${carrier}`).toEqual(CAPABILITIES[capability].grants);
      }
      for (const grant of byCarrier(fn, "StoragePrefix")) for (const resource of grant.resources) expect(resource).toMatch(/^\{(Media|Evidence)\}\/(?:guest\/\*\/)?[a-z]+\/\*$/);
    }
    expect(byCarrier("ToolEvidence", "PhotoModel")).toEqual([
      { actions: ["bedrock:InvokeModel"], resources: ["{model:PHOTO}"] },
      { sid: "ModelProfileRead", actions: ["bedrock:GetInferenceProfile"], resources: ["{model:PROFILE}"] },
    ]);
  });

  it("links for their runtime only what their code reads", () => {
    expect(spec.toolRuntimeLinks("ToolOrders")).toEqual(["SessionTokenKey", "ChannelModes", "SeedOverrides", "BrandConfig", "WhatsAppPhoneNumberId"]);
    expect(spec.toolRuntimeLinks("ToolKnowledge")).toEqual(["SessionTokenKey"]);
    expect(spec.toolRuntimeLinks("ToolMessaging")).toEqual(["SessionTokenKey", "ChannelModes", "SeedOverrides", "BrandConfig", "WhatsAppPhoneNumberId"]);
    expect(spec.toolRuntimeLinks("ToolEvidence")).toEqual(["SessionTokenKey", "ChannelModes", "SeedOverrides", "BrandConfig", "WhatsAppPhoneNumberId", "CostCaps"]);
  });

  it("are invoked by the Gateway role and the QaDriver only", () => {
    const targets = new Set(TOOL_FUNCTIONS.map((fn) => `{${fn}}`));
    const invokers = ROLES.filter((role) => expectedGrants(role).some((grant) => grant.actions.includes("lambda:InvokeFunction") && grant.resources.some((resource) => targets.has(resource))));
    expect(invokers.sort()).toEqual(["Gateway", "QaDriver"]);
    expect(read("infra/mocks.ts")).toMatch(/ToolOrders: "agent-tools",\n\s+ToolEvidence: "agent-tools",\n\s+ToolCases: "agent-tools"/);
    for (const fn of TOOL_FUNCTIONS) expect(read("infra/agent-tools.ts")).toContain(`export const ${fn.charAt(0).toLowerCase()}${fn.slice(1)} = `);
  });
});

describe("Gateway targets (docs/architecture.md §9.2)", () => {
  const payloads = Object.fromEntries(GATEWAY_TARGETS.map((target) => [target, gatewayToolSchemas[target].inlinePayload])) as Record<GatewayTarget, (typeof gatewayToolSchemas)[GatewayTarget]["inlinePayload"]>;

  it("are named like the Cedar action ids expect, with 12 tools the Harness can name", () => {
    for (const target of GATEWAY_TARGETS) {
      expect(target).toMatch(/^([0-9a-zA-Z][-]?){1,100}$/);
      expect(gatewayToolSchemas[target].inlinePayload.map((tool) => tool.name)).toEqual([...GATEWAY_TOOLS[target]]);
      for (const tool of GATEWAY_TOOLS[target]) expect(actionId(target, tool)).toMatch(TOOL_NAME);
    }
    expect(Object.values(payloads).flat()).toHaveLength(12);
  });

  it("carry a stable schema digest in a description the Gateway accepts", () => {
    for (const target of GATEWAY_TARGETS) {
      const { inlinePayload } = gatewayToolSchemas[target];
      const digest = spec.schemaDigest(inlinePayload);
      expect(digest).toMatch(/^[0-9a-f]{12}$/);
      expect(spec.schemaDigest(JSON.parse(JSON.stringify(inlinePayload)))).toBe(digest);
      const description = spec.gatewayTargetDescription(target, inlinePayload.length, digest);
      expect(description.length).toBeLessThanOrEqual(200);
      expect(description).toContain(digest);
    }
  });

  it("ignore the Cloud Control read-back unless a schema rollout names the target", () => {
    expect([...spec.TARGET_IGNORED_FIELDS]).toEqual(["metadataConfiguration", "targetConfiguration", "description"]);
    for (const target of GATEWAY_TARGETS) {
      expect(spec.gatewayTargetIgnoreChanges(target)).toEqual(spec.GATEWAY_SCHEMA_ROLLOUT.includes(target) ? ["metadataConfiguration"] : [...spec.TARGET_IGNORED_FIELDS]);
    }
  });

  it("match every Cedar statement against the very payloads infra/agentcore.ts deploys", () => {
    const policies = cedarPolicies({ gatewayArn: `arn:aws:bedrock-agentcore:us-east-1:${PLACE.account}:gateway/g-1`, harnessPrincipalId: `arn:aws:sts::${PLACE.account}:assumed-role/h` });
    expect(schemaProblems(policies, inputSchemasByAction(payloads))).toEqual([]);
  });
});

describe("runtime log group and content in traces (docs/architecture.md §12)", () => {
  it("names the live endpoint's group, never DEFAULT's, with the retention of §12", () => {
    expect(spec.runtimeLogGroupEndpoints()).toEqual([spec.HARNESS_ENDPOINT_NAME]);
    expect(() => spec.runtimeLogGroupEndpoints("DEFAULT")).toThrow(/DEFAULT/);
    expect(spec.runtimeLogGroupName("harness_x-Ab12", "live")).toBe("/aws/bedrock-agentcore/runtimes/harness_x-Ab12-live");
    expect(() => spec.runtimeLogGroupName("../x", "live")).toThrow();
    expect(observability).toContain(`Retención de ${spec.AGENT_LOG_RETENTION_DAYS} días en todo grupo`);
  });

  it("records that no Harness or endpoint field turns content capture off, so retention is what is fixed", () => {
    const fields = recordedFields(spec.TRACE_CONTENT_CAPTURE.checked);
    expect(fields).toEqual(expect.arrayContaining(["executionRoleArn", "targetVersion"]));
    expect(fields.filter((field) => /observab|capture|telemetry|trac|logging|content/i.test(field))).toEqual([]);
    expect(spec.TRACE_CONTENT_CAPTURE).toMatchObject({ captureCanBeTurnedOff: false, decision: "RETENTION", runtimeLogGroupRetentionDays: spec.AGENT_LOG_RETENTION_DAYS });
  });

  it("declares the DEFAULT group's 30 days as the manual configuration of §17 item 15: no pinned provider models it (ADR-0028)", () => {
    const record = spec.DEFAULT_RUNTIME_LOG_RETENTION;
    const fields = recordedFields(record.checked);
    expect(fields).toEqual(expect.arrayContaining(["executionRoleArn", "targetVersion", "harnessName", "agentRuntimeName"]));
    expect(fields.filter((field) => /retention|logGroup|logging|logConfig/i.test(field))).toEqual([]);
    expect(record).toMatchObject({ modeledByProvider: false, retentionDays: 30, manualConfig: "docs/architecture.md §17 item 15" });
    const item15 = architecture.split("\n").find((line) => line.startsWith("| 15 |")) ?? "";
    for (const command of [record.apply, record.verify]) expect(item15).toContain(`\`${command}\``);
    expect(record.apply).toContain(`<runtimeId>-${spec.RUNTIME_DEFAULT_ENDPOINT} --retention-in-days ${spec.AGENT_LOG_RETENTION_DAYS}`);
  });
});

describe("the app's inference profile (ADR-0028)", () => {
  it("is named after the model as §1 documents it, copies the global profile and is what Harness, Memory and PhotoModel call", () => {
    const name = spec.appModelProfileName(APP, STAGE);
    expect([name, name.length <= 64, accountSection.includes(`\`${name}\``)]).toEqual([`${APP}-${STAGE}-sonnet-5-5`, true, true]);
    for (const text of [name, spec.appModelProfileDescription(APP, STAGE)]) expect(text).toMatch(/^([0-9a-zA-Z:.][ _-]?)+$/);
    expect(spec.appModelProfileName(APP, STAGE, "global.anthropic.claude-opus-5")).toBe(`${APP}-${STAGE}-opus-5`);
    expect(spec.globalModelProfileArn(PLACE.region, PLACE.account)).toBe(`arn:aws:bedrock:us-east-1:${PLACE.account}:inference-profile/${spec.HARNESS_MODEL_ID}`);
    expect(spec.photoInvokeModelId(PROFILE)).toBe(PROFILE);
    expect(modelRefArns("{model:PHOTO}", PLACE, PROFILE)).toEqual(agentModelArns(spec.HARNESS_MODEL_ID, PLACE.region, PLACE.account, PROFILE));
    expect(read("infra/agent-tools.ts")).toContain("invokeModelId: profileArn.apply(photoInvokeModelId)");
    expect(read("infra/agentcore-iam.ts")).toMatch(/new aws\.bedrock\.InferenceProfile\("AgentModelProfile", \{\s+name: appModelProfileName\(\$app\.name, \$app\.stage\),[\s\S]*?copyFrom: /);
  });
});

describe("IAM of the agent roles (docs/architecture.md §14)", () => {
  const functionArns = TOOL_FUNCTIONS.map((fn) => `arn:aws:lambda:us-east-1:${PLACE.account}:function:${fn}`);
  const refs = {
    "{G1}": ["arn:g1"],
    "{Gateway}": ["arn:gateway"],
    "{Memory}": ["arn:memory"],
    "{PolicyEngine}": ["arn:engine"],
    "{model:PROFILE}": [PROFILE],
    ...Object.fromEntries(TOOL_FUNCTIONS.map((fn, index) => [`{${fn}}`, [functionArns[index] ?? ""]])),
  };
  const statements = (role: AgentRole): AgentStatement[] => agentRoleStatements(role, refs, PLACE, APP, STAGE);
  const bySid = (role: AgentRole, sid: string): AgentStatement | undefined => statements(role).find((statement) => statement.sid === sid);

  it("gives each role exactly its SERVICE_ROLES grants of infra/iam-capabilities.ts, resolved", () => {
    for (const role of ["Harness", "Gateway", "Memory"] as const) {
      const declared: readonly Grant[] = SERVICE_ROLES[role].grants;
      expect(capabilityStatements(role, refs, PLACE).map((statement) => statement.actions)).toEqual(declared.map((grant) => grant.actions));
    }
    expect(bySid("Harness", "Model")?.resources).toEqual(agentModelArns(spec.HARNESS_MODEL_ID, PLACE.region, PLACE.account, PROFILE));
    expect(bySid("Harness", "ModelProfileRead")).toEqual({ sid: "ModelProfileRead", actions: ["bedrock:GetInferenceProfile"], resources: [PROFILE] });
    expect(bySid("Harness", "GuardrailG1")?.resources).toEqual(["arn:g1"]);
    expect(bySid("Harness", "Gateway")?.resources).toEqual(["arn:gateway"]);
    expect(bySid("Harness", "Memory")?.resources).toEqual(["arn:memory"]);
    expect(statements("Memory")).toEqual([
      { sid: "ExtractionModel", actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], resources: agentModelArns(spec.HARNESS_MODEL_ID, PLACE.region, PLACE.account, PROFILE) },
      { sid: "ModelProfileRead", actions: ["bedrock:GetInferenceProfile"], resources: [PROFILE] },
    ]);
    expect(() => agentRoleStatements("Harness", {}, PLACE, APP, STAGE)).toThrow(/needs the ARN/);
  });

  it("lets the Harness run and never invoke, delete or write anything of the app", () => {
    const actions = statements("Harness").flatMap((statement) => statement.actions);
    expect(actions.filter((action) => /Invoke(Harness|AgentRuntime|Function)|Delete|Put(Item|Object)/.test(action))).toEqual([]);
    expect(actions.filter((action) => !/^(bedrock|bedrock-agentcore|logs|xray|cloudwatch|ecr-public|sts):/.test(action))).toEqual([]);
    for (const statement of statements("Harness")) if (statement.resources.includes("*")) expect(AGENT_ROLE_WILDCARD_SIDS, statement.sid).toContain(statement.sid);
    expect(bySid("Harness", "Metrics")?.condition).toEqual({ StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } });
    const group = `arn:aws:logs:us-east-1:${PLACE.account}:log-group:${spec.runtimeLogGroupName(`harness_${spec.harnessName(APP, STAGE)}-Ab12Cd34Ef`, "live")}`;
    expect(bySid("Harness", "RuntimeLogGroup")?.resources.some((pattern) => covers(pattern, group))).toBe(true);
    expect(bySid("Harness", "RuntimeLogStreams")?.resources.some((pattern) => covers(pattern, `${group}:log-stream:runtime-logs`))).toBe(true);
    expect(bySid("Harness", "RuntimeLogGroup")?.resources.some((pattern) => covers(pattern, group.replace("cuadrilla", "other")))).toBe(false);
  });

  it("lets the Gateway invoke the five targets and evaluate Cedar on the stage's engine, nothing else", () => {
    expect(bySid("Gateway", "InvokeToolTargets")).toEqual({ sid: "InvokeToolTargets", actions: ["lambda:InvokeFunction"], resources: functionArns });
    expect(statements("Gateway").flatMap((statement) => statement.actions).filter((action) => action.startsWith("lambda:"))).toEqual(["lambda:InvokeFunction"]);
    expect(bySid("Gateway", "PolicyEngineAuthorization")?.resources).toEqual(["arn:engine", `arn:aws:bedrock-agentcore:us-east-1:${PLACE.account}:gateway/${APP}-${STAGE}-*`]);
  });

  it("trusts AgentCore of this account only: the stage's Memory, the stage's Gateways, the account's agents", () => {
    const trust = JSON.parse(agentCoreTrustPolicy(PLACE, trustSourcePattern("Memory", PLACE, APP, STAGE))) as { Statement: Array<{ Principal: unknown; Condition: unknown }> };
    expect(trust.Statement).toHaveLength(1);
    expect(trust.Statement[0]?.Principal).toEqual({ Service: "bedrock-agentcore.amazonaws.com" });
    expect(trust.Statement[0]?.Condition).toEqual({ StringEquals: { "aws:SourceAccount": PLACE.account }, ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:us-east-1:${PLACE.account}:memory/${spec.memoryName(APP, STAGE)}-*` } });
    expect(covers(trustSourcePattern("Memory", PLACE, APP, STAGE), `arn:aws:bedrock-agentcore:us-east-1:${PLACE.account}:memory/${spec.memoryName(APP, STAGE)}-Ab12Cd34Ef`)).toBe(true);
    expect(trustSourcePattern("Gateway", PLACE, APP, STAGE)).toBe(`arn:aws:bedrock-agentcore:us-east-1:${PLACE.account}:gateway/${APP}-${STAGE}-*`);
    const document = JSON.parse(policyDocument(statements("Harness"))) as { Version: string; Statement: Array<{ Effect: string }> };
    expect(document.Version).toBe("2012-10-17");
    expect(document.Statement.every((statement) => statement.Effect === "Allow")).toBe(true);
  });

  it("stays inside the permissions boundary of the CI bootstrap, untagged resources by name", () => {
    const boundary = boundaryAllows();
    // The app's inference profile carries `sst:app` (the provider's default tags): GetInferenceProfile rides TaggedAppResources.
    const tagged = new Set(["GuardrailG1", "Gateway", "Memory", "InvokeToolTargets", "PolicyEngineConfiguration", "PolicyEngineAuthorization", "ModelProfileRead"]);
    for (const role of ["Harness", "Gateway", "Memory"] as const) {
      for (const statement of statements(role)) {
        for (const action of statement.actions) {
          const allowing = boundary.filter((candidate) => candidate.actions.some((pattern) => covers(pattern, action)) && (tagged.has(statement.sid) ? candidate.tagged : !candidate.tagged));
          const reaches = allowing.some((candidate) => candidate.tagged || statement.resources.every((resource) => candidate.resources.some((pattern) => covers(pattern, resource))));
          expect(reaches, `${role} ${statement.sid} ${action}`).toBe(true);
        }
      }
    }
  });
});

describe("Linkables", () => {
  it("carry exactly the grants of their capability, under the names their consumers read", () => {
    expect(spec.harnessInvokeActions()).toEqual(["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:InvokeHarness"]);
    expect(ROLES.filter((role) => expectedGrants(role).some((grant) => grant.resources.includes(spec.HARNESS_REF)))).toEqual(["InstallerWorker"]);
    for (const grant of CAPABILITIES.MEMORY_ADMIN.grants) expect(grant.resources).toEqual([spec.MEMORY_REF]);
    const memoryHolders = (Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).filter((fn) => resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities).includes("MEMORY_ADMIN"));
    // The world factory of guest worlds and the account deletion purge a generation's memory too (ADR-0025 §2 and §6).
    expect(memoryHolders.sort()).toEqual(["Bff", "GuestAccountDeletion", "GuestWorlds", "QaDriver", "WorldJanitor"]);
    expect(read("infra/leads.ts")).toContain(`lateLinks("leads", "agentcore", () => import("./agentcore"), ["${spec.MEMORY_LINK}"], "optional")`);
    expect(read("infra/workers.ts")).toContain(`agentcore: ["${spec.HARNESS_LINK}"]`);
    expect(read("infra/scheduler.ts")).toContain(`agentcore: ["${spec.MEMORY_LINK}"]`);
    expect(read("infra/agentcore.ts")).toMatch(/export const Harness = new sst\.Linkable\(HARNESS_LINK, [\s\S]+export const Memory = new sst\.Linkable\(MEMORY_LINK, /);
  });
});
