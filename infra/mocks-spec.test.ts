// infra/messaging-whatsapp.ts, infra/mocks.ts and infra/feeds.ts only evaluate inside the SST program,
// so this test evaluates them against a recording fake of its globals ($app, sst, aws, $util,
// $interpolate): every component is kept with its arguments and every Output is a promise the test
// resolves. The modules of other work packages they read late (workers, agent-tools, bff) are faked
// per scenario, exported the way those modules export them.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DISPATCH_EVENT_SOURCE, DispatchEventType } from "../packages/dispatch-mock/src/events";
import { CAPABILITIES, IAM_ARNS, WORLDS_LEADING_KEYS, actionDrift, type LambdaName } from "./iam-capabilities";
import { TABLE_ACTIONS, dataActions } from "./storage-access";
import { SNS_SIGNATURE_VERSION } from "../packages/bff/src/channels/whatsapp/config";

const HEX = "0123456789abcdef".repeat(2);
const PHONE_ARN = `arn:aws:social-messaging:us-east-1:776805327629:phone-number-id/${HEX}`;
const roleArn = (name: string): string => `arn:aws:iam::776805327629:role/aws-cds-hackathon-poc-cuadrilla/${name}Role`;

// ---- A recording SST runtime ------------------------------------------------------------------------

class FakeOutput {
  constructor(readonly promise: Promise<unknown>) {
    promise.catch(() => undefined);
  }
  apply(fn: (value: never) => unknown): FakeOutput {
    return new FakeOutput(this.promise.then((value) => settle(fn(value as never))));
  }
}
const settle = (value: unknown): unknown => (value instanceof FakeOutput ? value.promise : value);
const output = (value: unknown): FakeOutput => (value instanceof FakeOutput ? value : new FakeOutput(Promise.resolve(value).then(settle)));

interface Created {
  readonly type: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

interface Scenario {
  readonly phoneId: string;
  /** Which later modules already export their Functions (as their real modules name them). */
  readonly late: { readonly workers?: boolean; readonly tools?: boolean; readonly bff?: boolean };
}

function fakeRuntime(scenario: Scenario) {
  const created: Created[] = [];
  const warn = vi.fn();
  const record = (type: string, name: string, args: unknown): void => void created.push({ type, name, args: (args ?? {}) as Record<string, unknown> });
  class Resource {
    readonly arn: FakeOutput;
    readonly name: FakeOutput;
    constructor(type: string, name: string, args: unknown, arn = `arn:fake:${type}:${name}`) {
      record(type, name, args);
      this.arn = output(arn);
      this.name = output(name);
    }
  }
  class Fn extends Resource {
    readonly url: FakeOutput;
    readonly nodes: { role: { arn: FakeOutput } };
    constructor(name: string, args: unknown) {
      super("sst.aws.Function", name, args, `arn:aws:lambda:us-east-1:776805327629:function:${name}`);
      this.url = output(`https://${name}.lambda-url.us-east-1.on.aws/`);
      this.nodes = { role: { arn: output(roleArn(name)) } };
    }
  }
  class Linkable extends Resource {
    static readonly wrap = vi.fn();
    constructor(name: string, readonly definition: { include?: unknown[] }) {
      super("sst.Linkable", name, definition);
    }
  }
  class SnsTopic extends Resource {
    constructor(name: string, args: { transform: { topic: (topic: Record<string, unknown>) => void } }) {
      const topic: Record<string, unknown> = {};
      args.transform.topic(topic);
      super("sst.aws.SnsTopic", name, { ...args, topic }, `arn:aws:sns:us-east-1:776805327629:${String(topic.name)}`);
    }
    subscribe(name: string, subscriber: unknown, args?: unknown): FakeOutput {
      record("sst.aws.SnsTopic.subscribe", name, { subscriber, args });
      return output({});
    }
  }
  class Bus extends Resource {
    constructor(name: string, args?: unknown) {
      super("sst.aws.Bus", name, args);
    }
    subscribe(name: string, subscriber: unknown, args?: unknown): FakeOutput {
      record("sst.aws.Bus.subscribe", name, { subscriber, args });
      return output({ rule: name });
    }
  }
  const resource = (type: string) =>
    class extends Resource {
      constructor(name: string, args: unknown) {
        super(type, name, args);
      }
    };
  const sst = {
    Secret: class {
      constructor(readonly secretName: string) {}
      get value(): FakeOutput {
        return output(this.secretName === "WhatsAppPhoneNumberId" ? scenario.phoneId : `value-of-${this.secretName}`);
      }
    },
    Linkable,
    aws: { Function: Fn, SnsTopic, Bus, Dynamo: resource("sst.aws.Dynamo"), permission: (input: object) => ({ type: "aws.permission", ...input }) },
  };
  const aws = { sns: { TopicPolicy: resource("aws.sns.TopicPolicy") }, lambda: { Permission: resource("aws.lambda.Permission") } };
  const util = { output, all: (values: unknown[]) => new FakeOutput(Promise.all(values.map((value) => output(value).promise))), log: { warn } };
  const interpolate = (strings: TemplateStringsArray, ...values: unknown[]) =>
    new FakeOutput(Promise.all(values.map((value) => output(value).promise)).then((parts) => strings.reduce((text, piece, i) => `${text}${piece}${i < parts.length ? String(parts[i]) : ""}`, "")));
  return { sst, aws, util, interpolate, created, warn, Fn };
}

/** Resolves every Output inside plain objects and arrays; class instances stay as they are. */
async function resolveDeep(value: unknown): Promise<unknown> {
  if (value instanceof FakeOutput) return resolveDeep(await value.promise);
  if (Array.isArray(value)) return Promise.all(value.map(resolveDeep));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, inner]) => [key, await resolveDeep(inner)] as const)));
  }
  return value;
}

const LATE_KEYS = ["InstallerEvents", "InstallerWorker", "installerWorker", "FeedEvents", "feedEvents", "ToolOrders", "toolOrders", "ToolEvidence", "toolEvidence", "ToolCases", "toolCases", "Bff", "bff", "QaDriver", "qaDriver"];
const STORAGE = ["Isps", "People", "WorkOrders", "Cases", "Conversations", "AuditLog", "Reference", "Runtime", "CuadrillaMetrics", "Media", "Evidence", "Manual", "Seed"];

async function evaluate(scenario: Scenario) {
  const runtime = fakeRuntime(scenario);
  vi.resetModules();
  vi.stubGlobal("$app", { name: "aws-cds-hackathon-poc-cuadrilla", stage: "poc" });
  vi.stubGlobal("sst", runtime.sst);
  vi.stubGlobal("aws", runtime.aws);
  vi.stubGlobal("$util", runtime.util);
  vi.stubGlobal("$interpolate", runtime.interpolate);
  const storage = Object.fromEntries(STORAGE.map((name) => [name, { name: output(name), arn: output(`arn:storage:${name}`) }]));
  vi.doMock("./storage-tables", () => ({ ...storage, tables: storage }));
  vi.doMock("./storage-buckets", () => ({ buckets: storage, mediaBucket: storage.Media, evidenceBucket: storage.Evidence, manualBucket: storage.Manual, seedBucket: storage.Seed }));
  const fn = (name: string) => () => new runtime.Fn(name, { handler: `late/${name}` });
  const queue = () => new runtime.sst.Linkable("InstallerEvents", { include: [{ type: "aws.permission", actions: ["sqs:SendMessage"], resources: ["arn:queue"] }] });
  // Exported the way each real module names them; every other candidate key exists and is undefined.
  const lateModule = (present: boolean | undefined, make: Record<string, () => unknown>) => () =>
    Object.fromEntries(LATE_KEYS.map((key) => [key, present === true && make[key] ? make[key]() : undefined]));
  vi.doMock("./workers", lateModule(scenario.late.workers, { InstallerEvents: queue, installerWorker: fn("InstallerWorker"), feedEvents: fn("FeedEvents") }));
  vi.doMock("./agent-tools", lateModule(scenario.late.tools, { ToolOrders: fn("ToolOrders"), toolEvidence: fn("ToolEvidence"), toolCases: fn("ToolCases") }));
  vi.doMock("./bff", lateModule(scenario.late.bff, { bff: fn("Bff"), qaDriver: fn("QaDriver") }));
  // The Linkables of PIPELINE that InboundWhatsApp links, each carrying exactly its capability's grants.
  const carrying = (name: string, grants: ReadonlyArray<{ actions: readonly string[] }>) =>
    new runtime.sst.Linkable(name, { include: grants.map((grant) => ({ type: "aws.permission", actions: [...grant.actions], resources: [`arn:fake:${name}`] })) });
  vi.doMock("./guardrail", () => ({ GuardrailG2: carrying("GuardrailG2", CAPABILITIES.PIPELINE.grants), GuardrailG3: carrying("GuardrailG3", CAPABILITIES.PIPELINE.grants) }));
  vi.doMock("./messaging-email", () => ({ EmailChannel: carrying("EmailChannel", CAPABILITIES.SEND_EMAIL.grants) }));
  vi.doMock("./scheduler", () => ({ Scheduler: carrying("Scheduler", CAPABILITIES.TIMERS.grants) }));
  const whatsapp = await import("./messaging-whatsapp");
  const mocks = await import("./mocks");
  const feeds = await import("./feeds");
  const policy = (await resolveDeep(runtime.created.find((entry) => entry.type === "aws.sns.TopicPolicy")?.args.policy)) as string;
  await resolveDeep([mocks.mockInvokeGrants, feeds.feedEventsRule]);
  const named = (type: string, name: string): Created => {
    const found = runtime.created.filter((entry) => entry.type === type && entry.name === name);
    expect(found, `${type} ${name}`).toHaveLength(1);
    return found[0] as Created;
  };
  return { ...runtime, whatsapp, mocks, feeds, policy: JSON.parse(policy) as { Statement: Array<Record<string, unknown>> }, named };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const path of ["./storage-tables", "./storage-buckets", "./workers", "./agent-tools", "./bff", "./guardrail", "./messaging-email", "./scheduler"]) vi.doUnmock(path);
});

type Statement = { actions: string[]; resources: string[]; conditions?: Array<{ test: string; variable: string; values: string[] }> };
const ALL = { workers: true, tools: true, bff: true } as const;
const CONNECTED: Scenario = { phoneId: `phone-number-id-${HEX}`, late: ALL };
const statementsOf = async (entry: Created): Promise<Statement[]> => (await resolveDeep(entry.args.permissions)) as Statement[];
const includesOf = async (links: unknown): Promise<Statement[]> =>
  ((await resolveDeep(links)) as Array<{ definition?: { include?: unknown[] } }>).flatMap((link) => (link.definition?.include ?? []) as Statement[]);

describe("WhatsApp inbound topic (P-01 option A, docs/architecture-integrations.md §4.4)", () => {
  it("is the standard topic aws-cds-hackathon-poc-cuadrilla-wa-inbound that IAM_ARNS names", async () => {
    const { named } = await evaluate(CONNECTED);
    const topic = named("sst.aws.SnsTopic", "WaInboundTopic").args as { fifo: boolean; topic: { name: string } };
    expect(topic.fifo).toBe(false);
    expect(topic.topic.name).toBe("aws-cds-hackathon-poc-cuadrilla-wa-inbound");
    expect(IAM_ARNS.waTopic).toBe(`arn:aws:sns:us-east-1:776805327629:${topic.topic.name}`);
  });

  it("signs with SignatureVersion 2, the only version InboundWhatsApp accepts (SNS defaults to SHA1, version 1)", async () => {
    const { named } = await evaluate(CONNECTED);
    const topic = named("sst.aws.SnsTopic", "WaInboundTopic").args as { topic: { signatureVersion?: number } };
    expect(topic.topic.signatureVersion).toBe(2);
    expect(String(topic.topic.signatureVersion)).toBe(SNS_SIGNATURE_VERSION);
  });

  it("links InboundWhatsApp the topic's ARN as WaInboundOrigin, with no permission, so a live record is bound to our topic", async () => {
    const { named } = await evaluate(CONNECTED);
    const origin = named("sst.Linkable", "WaInboundOrigin").args as { properties: { arn: unknown }; include?: unknown[] };
    expect(await resolveDeep(origin.properties.arn)).toBe(IAM_ARNS.waTopic);
    expect(origin.include).toBeUndefined();
  });

  it("lets EUM Social (same account) and the QaDriver's role publish and denies sns:Publish to every other principal", async () => {
    const { policy } = await evaluate(CONNECTED);
    const topic = IAM_ARNS.waTopic;
    expect(policy.Statement).toEqual([
      { Sid: "EndUserMessagingSocialPublishes", Effect: "Allow", Principal: { Service: "social-messaging.amazonaws.com" }, Action: "sns:Publish", Resource: topic, Condition: { StringEquals: { "aws:SourceAccount": "776805327629" } } },
      { Sid: "QaDriverPublishesForeignEvents", Effect: "Allow", Principal: { AWS: roleArn("QaDriver") }, Action: "sns:Publish", Resource: topic },
      {
        Sid: "DenyEveryOtherPublisher",
        Effect: "Deny",
        Principal: "*",
        Action: "sns:Publish",
        Resource: topic,
        Condition: { StringNotEquals: { "aws:PrincipalServiceName": "social-messaging.amazonaws.com" }, ArnNotEquals: { "aws:PrincipalArn": roleArn("QaDriver") } },
      },
    ]);
  });

  it("lets only the service publish while infra/bff.ts exports no QaDriver", async () => {
    const { policy, warn } = await evaluate({ ...CONNECTED, late: { workers: true, tools: true } });
    expect(policy.Statement.map((statement) => statement.Sid)).toEqual(["EndUserMessagingSocialPublishes", "DenyEveryOtherPublisher"]);
    expect(policy.Statement[1]?.Condition).toEqual({ StringNotEquals: { "aws:PrincipalServiceName": "social-messaging.amazonaws.com" } });
    expect(warn.mock.calls.flat().join("\n")).toMatch(/exports no QaDriver Function yet/);
  });

  it("subscribes InboundWhatsApp with no filter, no redrive policy and no failure destination", async () => {
    const { named, whatsapp } = await evaluate(CONNECTED);
    const subscription = named("sst.aws.SnsTopic.subscribe", "InboundWhatsApp").args;
    expect(subscription).toEqual({ subscriber: whatsapp.InboundWhatsApp.arn, args: undefined });
    const fn = named("sst.aws.Function", "InboundWhatsApp").args;
    expect(Object.keys(fn).filter((key) => /retr|fail|dead|dlq|destination/i.test(key))).toEqual([]);
    expect(fn).toMatchObject({ handler: "packages/bff/src/handlers/inbound-whatsapp.handler", concurrency: { reserved: 10 } });
    expect(existsSync(resolve(process.cwd(), "packages/bff/src/handlers/inbound-whatsapp.ts"))).toBe(true);
  });

  it("links the QaDriver's view of the topic with sns:Publish on it and nothing else", async () => {
    const { named } = await evaluate(CONNECTED);
    const link = named("sst.Linkable", "WaInbound").args as { include: unknown[] };
    expect(await resolveDeep(link.include)).toEqual([{ type: "aws.permission", actions: ["sns:Publish"], resources: [IAM_ARNS.waTopic] }]);
  });
});

describe("InboundWhatsApp IAM (docs/architecture.md §14)", () => {
  async function granted(scenario: Scenario) {
    const run = await evaluate(scenario);
    const fn = run.named("sst.aws.Function", "InboundWhatsApp");
    const statements = [...(await statementsOf(fn)), ...(await includesOf(fn.args.link))];
    // Data access (its tables and Media, infra/storage.ts) versus the grants of its capabilities.
    const isData = (statement: Statement) => statement.resources.every((resource) => /^arn:storage:[A-Za-z]+(\/index\/\*|\/\*)?$/.test(resource));
    const data = statements.filter(isData).flatMap((statement) => statement.actions);
    expect([...new Set(data)].sort()).toEqual(dataActions("InboundWhatsApp"));
    const own = statements.filter((statement) => !isData(statement)).flatMap((statement) => statement.actions);
    return { run, fn, statements, drift: actionDrift("InboundWhatsApp", [...new Set(own)]) };
  }

  it("holds exactly its capabilities, EUM Social only on our number's ARN and * only for fenced metrics", async () => {
    const { statements, drift } = await granted(CONNECTED);
    expect(drift).toEqual({ extra: [], missing: [] });
    for (const statement of statements) {
      if (statement.actions.some((action) => action.startsWith("social-messaging:"))) expect(statement.resources).toEqual([PHONE_ARN]);
      for (const action of statement.actions) expect(action).not.toMatch(/PutWhatsAppBusinessAccountEventDestinations|ReceiptRule|\*/);
      if (statement.resources.includes("*")) expect(statement).toEqual({ actions: ["cloudwatch:PutMetricData"], resources: ["*"], conditions: [{ test: "StringEquals", variable: "cloudwatch:namespace", values: ["CuadrillaAgent"] }] });
    }
    expect(statements.find((statement) => statement.actions.includes("sqs:SendMessage"))?.resources).toEqual(["arn:queue"]);
    expect(statements).toContainEqual({ actions: ["s3:GetObject"], resources: ["arn:storage:Evidence/certificates/*", "arn:storage:Evidence/photos/*"] });
  });

  it("omits every social-messaging statement while the number id is the placeholder, never widening it", async () => {
    const { statements, drift } = await granted({ ...CONNECTED, phoneId: "not-connected" });
    expect(statements.flatMap((statement) => statement.actions).filter((action) => action.startsWith("social-messaging:"))).toEqual([]);
    expect(drift).toEqual({ extra: [], missing: ["social-messaging:GetWhatsAppMessageMedia", "social-messaging:PostWhatsAppMessageMedia", "social-messaging:SendWhatsAppMessage"] });
    expect(JSON.stringify(statements)).not.toContain("phone-number-id/*");
  });

  it("gives any role with SEND_WHATSAPP its grants on our number only, and none with the placeholder id", async () => {
    const connected = await evaluate(CONNECTED);
    expect(await resolveDeep(connected.whatsapp.whatsappPermissions("InstallerWorker"))).toEqual([
      { actions: ["social-messaging:SendWhatsAppMessage", "social-messaging:PostWhatsAppMessageMedia"], resources: [PHONE_ARN] },
    ]);
    expect(await resolveDeep(connected.whatsapp.whatsappPermissions("Bff"))).toEqual([]);
    const pending = await evaluate({ ...CONNECTED, phoneId: "not-connected" });
    expect(await resolveDeep(pending.whatsapp.whatsappPermissions("InstallerWorker"))).toEqual([]);
  });

  it("links its tables, Media, the secrets it reads, ChannelModes, the installer queue, the origin topic and the pipeline's G2, G3, EmailChannel and Scheduler", async () => {
    const { fn } = await granted(CONNECTED);
    const names = ((await resolveDeep(fn.args.link)) as Array<{ name?: unknown; secretName?: string }>).map((link) => link.secretName ?? link.name);
    const linked = await Promise.all(names.map((name) => resolveDeep(name)));
    expect(linked.sort()).toEqual(
      ["AuditLog", "BrandConfig", "Cases", "ChannelModes", "Conversations", "EmailChannel", "GuardrailG2", "GuardrailG3", "InstallerEvents", "Isps", "Media", "People", "Reference", "Runtime", "Scheduler", "SeedOverrides", "SessionTokenKey", "WaInboundOrigin", "WhatsAppMetaPhoneNumberId", "WhatsAppPhoneNumberId", "WorkOrders"].sort(),
    );
  });
});

describe("NetworkMock and DispatchMock (docs/architecture-integrations.md §6-§7)", () => {
  it("own tables Network and Dispatch: PK/SK, no GSI, TTL expiresAt, encrypted", async () => {
    const { named } = await evaluate(CONNECTED);
    for (const table of ["Network", "Dispatch"]) {
      expect(named("sst.aws.Dynamo", table).args).toEqual({
        fields: { PK: "string", SK: "string" },
        primaryIndex: { hashKey: "PK", rangeKey: "SK" },
        ttl: "expiresAt",
        transform: { table: { serverSideEncryption: { enabled: true } } },
      });
    }
  });

  it("answer on Function URLs with AWS_IAM and reach only their table (and the Feeds bus for dispatch)", async () => {
    const { named } = await evaluate(CONNECTED);
    const network = named("sst.aws.Function", "NetworkMockApi");
    const dispatch = named("sst.aws.Function", "DispatchMockApi");
    for (const entry of [network, dispatch]) {
      expect(entry.args.url).toEqual({ authorization: "iam" });
      expect(existsSync(resolve(process.cwd(), `${String(entry.args.handler).replace(/\.handler$/, "")}.ts`))).toBe(true);
    }
    expect(await statementsOf(network)).toEqual([{ actions: TABLE_ACTIONS.write, resources: ["arn:fake:sst.aws.Dynamo:Network", "arn:fake:sst.aws.Dynamo:Network/index/*"] }]);
    expect(await statementsOf(dispatch)).toEqual([
      { actions: TABLE_ACTIONS.write, resources: ["arn:fake:sst.aws.Dynamo:Dispatch", "arn:fake:sst.aws.Dynamo:Dispatch/index/*"] },
      { actions: ["events:PutEvents"], resources: ["arn:fake:sst.aws.Bus:Feeds"] },
    ]);
  });

  it("carry MOCK_NETWORK and MOCK_DISPATCH in their Linkables: both invoke actions on that mock only", async () => {
    const { named } = await evaluate(CONNECTED);
    for (const [mock, capability] of [["NetworkMock", "MOCK_NETWORK"], ["DispatchMock", "MOCK_DISPATCH"]] as const) {
      const link = named("sst.Linkable", mock).args as { properties: unknown; include: unknown[] };
      const arn = `arn:aws:lambda:us-east-1:776805327629:function:${mock}Api`;
      expect(await resolveDeep(link.properties)).toEqual({ name: `${mock}Api`, url: `https://${mock}Api.lambda-url.us-east-1.on.aws/` });
      expect(await resolveDeep(link.include)).toEqual(CAPABILITIES[capability].grants.map((grant) => ({ type: "aws.permission", actions: grant.actions, resources: [arn], ...(grant.conditions ? { conditions: grant.conditions } : {}) })));
    }
  });

  it("are called by exactly the roles docs/architecture.md §14 lists", async () => {
    const { mocks } = await evaluate(CONNECTED);
    const doc = readFileSync(resolve(process.cwd(), "docs/architecture.md"), "utf8");
    const [, network = "", dispatch = ""] = /Invocantes de `NetworkMock`: ([^;]+); de `DispatchMock`: ([^|]+)/.exec(doc) ?? [];
    expect(mocks.mockInvokers("NetworkMock")).toEqual(network.match(/[A-Za-z]+/g));
    expect(mocks.mockInvokers("DispatchMock")).toEqual(dispatch.match(/[A-Za-z]+/g));
  });

  it("name each calling role in one pair of permissions: InvokeFunctionUrl (AWS_IAM) and InvokeFunction through the URL", async () => {
    const { created, mocks } = await evaluate(CONNECTED);
    const permissions = created.filter((entry) => entry.type === "aws.lambda.Permission");
    expect(permissions).toHaveLength(2 * (6 + 2));
    for (const mock of ["NetworkMock", "DispatchMock"] as const) {
      for (const caller of mocks.mockInvokers(mock)) {
        const pair = await Promise.all(permissions.filter((entry) => entry.name.startsWith(mock) && entry.name.endsWith(`For${caller}`)).map((entry) => resolveDeep(entry.args)));
        expect(pair).toEqual([
          { function: `${mock}Api`, principal: roleArn(caller), action: "lambda:InvokeFunctionUrl", functionUrlAuthType: "AWS_IAM" },
          { function: `${mock}Api`, principal: roleArn(caller), action: "lambda:InvokeFunction", invokedViaFunctionUrl: true },
        ]);
      }
    }
  });

  it("names no caller that its module does not export yet, and says so", async () => {
    const { created, warn } = await evaluate({ ...CONNECTED, late: { workers: true } });
    expect(created.filter((entry) => entry.type === "aws.lambda.Permission").map((entry) => entry.name)).toEqual(["NetworkMockUrlForInstallerWorker", "NetworkMockInvokeForInstallerWorker"]);
    const warnings = warn.mock.calls.flat().join("\n");
    for (const caller of ["ToolOrders", "ToolEvidence", "ToolCases", "Bff", "QaDriver"]) expect(warnings).toContain(`exports no ${caller} Function yet`);
  });

  it("gives each role the mocks it calls and fences the mocks' tables by leading keys for WORLDS roles", async () => {
    const { mocks } = await evaluate(CONNECTED);
    const names = async (fn: LambdaName) => Promise.all(mocks.mockLinks(fn).map((link) => resolveDeep(link.name)));
    expect(await names("InstallerWorker")).toEqual(["NetworkMock"]);
    expect(await names("Bff")).toEqual(["NetworkMock", "DispatchMock", "Dispatch", "Network"]);
    expect(await names("WorldJanitor")).toEqual(["Dispatch", "Network"]);
    expect(mocks.mockPermissions("InstallerWorker")).toEqual([]);
    for (const role of Object.keys(WORLDS_LEADING_KEYS) as Array<keyof typeof WORLDS_LEADING_KEYS>) {
      const [statement] = (await resolveDeep(mocks.mockPermissions(role))) as Statement[];
      expect(statement?.actions).toEqual(TABLE_ACTIONS.write);
      expect(statement?.conditions).toEqual([{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: WORLDS_LEADING_KEYS[role] }]);
    }
  });
});

describe("Feeds bus (docs/architecture-integrations.md §7)", () => {
  it("hands a linked bus its name and ARN and no events:* permission", async () => {
    const { sst: fake, feeds } = await evaluate(CONNECTED);
    expect(fake.Linkable.wrap).toHaveBeenCalledWith(fake.aws.Bus, feeds.busNameOnly);
    expect(feeds.busNameOnly({ name: "bus", arn: "arn:bus" })).toEqual({ properties: { name: "bus", arn: "arn:bus" } });
  });

  it("routes only the dispatcher's three event types to FeedEvents", async () => {
    const { named } = await evaluate(CONNECTED);
    const rule = named("sst.aws.Bus.subscribe", "FeedEvents").args as { subscriber: { name: FakeOutput }; args: unknown };
    expect(await resolveDeep(rule.subscriber.name)).toBe("FeedEvents");
    expect(rule.args).toEqual({ pattern: { source: [DISPATCH_EVENT_SOURCE], detailType: DispatchEventType.options } });
    expect(DispatchEventType.options).toEqual(["WorkOrderRescheduled", "WorkOrderReassigned", "WorkOrderCancelled"]);
  });

  it("creates no rule while infra/workers.ts exports no FeedEvents, and says so", async () => {
    const { created, warn } = await evaluate({ ...CONNECTED, late: {} });
    expect(created.filter((entry) => entry.type === "sst.aws.Bus.subscribe")).toEqual([]);
    expect(warn.mock.calls.flat().join("\n")).toMatch(/exports no FeedEvents Function yet/);
  });
});
