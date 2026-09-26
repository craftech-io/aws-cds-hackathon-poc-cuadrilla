// infra/workers.ts and infra/scheduler.ts as resources (docs/architecture.md §1, §7, §8, §9.3 and §14;
// ADR-0004, ADR-0017; docs/build-plan.md WP-27), evaluated against a recording stand-in for the SST
// globals: what is asserted is what the modules hand to SST and Pulumi. Storage is the real
// infra/storage.ts over recorded tables and buckets; the modules of other work packages are stand-ins
// that carry exactly the grants their capability has in infra/iam-capabilities.ts, so the
// least-privilege check compares what each function ends up with against that table.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CAPABILITIES, IAM_ARNS, QA_DRIVER_DLQ_ONLY_ACTIONS, SCHEDULE_GROUP, actionDrift, type CapabilityName, type LambdaName } from "./iam-capabilities";
import { dataAccessGrants } from "./storage-access";
import { storageFor } from "./storage-keys";

// ---- A recording SST runtime ------------------------------------------------------------------------

type Meta = { readonly type: string; readonly name: string };
type Recorded = Meta & { readonly args: unknown };
type Statement = { readonly actions: string[]; readonly resources: string[]; readonly conditions?: unknown };
type FunctionArgs = { readonly handler: string; readonly timeout: string; readonly memory: string; readonly link: unknown[]; readonly permissions: Statement[] };

class Leaf {
  constructor(readonly meta: Meta) {}
}
class FakeOutput {
  constructor(readonly value: Promise<unknown>) {
    value.catch(() => undefined); // rejections surface where a test awaits them, never as unhandled
  }
  apply = (fn: (value: unknown) => unknown): FakeOutput => new FakeOutput(this.value.then((value) => settle(fn(value))));
}
async function settle(value: unknown): Promise<unknown> {
  if (value instanceof FakeOutput) return settle(await value.value);
  if (value instanceof Promise) return settle(await value);
  if (Array.isArray(value)) return Promise.all(value.map(settle));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await settle(entry)])));
  }
  return value;
}
const metaOf = (value: unknown): Meta | undefined => (value instanceof Leaf ? value.meta : undefined);
const PATH = Symbol("path");

function fakeRuntime() {
  const recorded: Recorded[] = [];
  const warnings: string[] = [];
  const created = new Map<string, object>();
  const spaces = new Map<string, unknown>();
  const wraps = new Map<string, (instance: unknown) => unknown>();
  // A created resource: `.meta` says what it is, `.nodes.<x>` is another resource, and any other
  // property is an Output that resolves to "<name>.<property>".
  const resource = (type: string, name: string): object =>
    new Proxy(new Leaf({ type, name }), {
      get(target, prop) {
        if (prop === "meta") return target.meta;
        if (typeof prop === "symbol" || prop === "then") return undefined;
        if (prop === "nodes") return new Proxy({}, { get: (_nodes, node) => resource(`${type}.${String(node)}`, `${name}.${String(node)}`) });
        return new FakeOutput(Promise.resolve(`${name}.${prop}`));
      },
    });
  const once = (type: string, name: string): object => {
    if (!created.has(`${type}|${name}`)) created.set(`${type}|${name}`, resource(type, name));
    return created.get(`${type}|${name}`) as object;
  };
  const linkable = (name: string, actions: readonly string[]): object => {
    if (!created.has(`sst.Linkable|${name}`)) recorded.push({ type: "sst.Linkable", name, args: { include: [{ type: "aws.permission", actions: [...actions], resources: [`${name}.target`] }] } });
    return once("sst.Linkable", name);
  };
  const namespace = (path: string): unknown => {
    if (!spaces.has(path)) spaces.set(path, space(path));
    return spaces.get(path);
  };
  const space = (path: string): unknown =>
    new Proxy(function stub() {}, {
      get(_target, prop) {
        if (prop === PATH) return path;
        if (prop === Symbol.hasInstance) return (candidate: unknown) => metaOf(candidate)?.type === path;
        return typeof prop === "symbol" || prop === "then" ? undefined : namespace(`${path}.${prop}`);
      },
      construct(_target, args: unknown[]) {
        recorded.push({ type: path, name: String(args[0]), args: args[1] });
        return once(path, String(args[0]));
      },
      apply(_target, _this, args: unknown[]) {
        if (path === "sst.aws.permission") return { type: "aws.permission", ...(args[0] as object) };
        if (path === "sst.Linkable.wrap") return void wraps.set(Reflect.get(args[0] as object, PATH) as string, args[1] as (instance: unknown) => unknown);
        if (path.endsWith("Output")) return resource(path, "data");
        throw new Error(`the stand-in does not model ${path}()`);
      },
    });
  const interpolate = (strings: TemplateStringsArray, ...values: unknown[]) =>
    new FakeOutput(settle(values).then((parts) => strings.reduce((text, part, i) => `${text}${part}${i < values.length ? String((parts as unknown[])[i]) : ""}`, "")));
  const globals = {
    $app: { name: "aws-cds-hackathon-poc-cuadrilla", stage: "poc" },
    sst: namespace("sst"),
    aws: namespace("aws"),
    $util: { output: (value: unknown) => new FakeOutput(settle(value)), all: (value: unknown) => new FakeOutput(settle(value)), log: { warn: (text: string) => warnings.push(text) } },
    $interpolate: interpolate,
  };
  return { recorded, warnings, wraps, once, linkable, globals };
}

// ---- Evaluation --------------------------------------------------------------------------------------

const TABLES = ["Isps", "People", "WorkOrders", "Cases", "Conversations", "AuditLog", "Reference", "Runtime", "CuadrillaMetrics"];
const BUCKETS = ["Media", "Evidence", "Manual", "Seed"];
const SECRETS = ["SessionTokenKey", "WabaId", "WhatsAppPhoneNumberId", "WhatsAppMetaPhoneNumberId", "SeedOverrides", "BrandConfig"];
const capabilityActions = (name: CapabilityName): string[] => [...new Set(CAPABILITIES[name].grants.flatMap((grant) => grant.actions))];
const arnOf = (resource: string): string => resource.replace(/^\{(\w+)\}/, "$1.arn");
const NUMBER_STATEMENT = { actions: ["social-messaging:SendWhatsAppMessage", "social-messaging:PostWhatsAppMessageMedia"], resources: ["whatsappPhone"] };
const mockTableStatement = (fn: LambdaName) => dataAccessGrants(fn).mocks.map((grant) => ({ actions: [...grant.actions], resources: grant.resources.map(arnOf), conditions: grant.conditions }));

/** `built`: every owner exports what its contract promises. `stubs`: every owner is still a WP-02 stub. */
async function evaluate(owners: "built" | "stubs") {
  const rt = fakeRuntime();
  vi.resetModules();
  for (const [name, value] of Object.entries(rt.globals)) vi.stubGlobal(name, value);
  const tables = Object.fromEntries(TABLES.map((name) => [name, rt.once("sst.aws.Dynamo", name)]));
  const buckets = Object.fromEntries(BUCKETS.map((name) => [name, rt.once("sst.aws.Bucket", name)]));
  vi.doMock("./storage-tables", () => ({ ...tables, tables }));
  vi.doMock("./storage-buckets", () => ({ buckets, mediaBucket: buckets.Media, evidenceBucket: buckets.Evidence, manualBucket: buckets.Manual, seedBucket: buckets.Seed }));
  vi.doMock("./guardrail", () => Object.fromEntries(["GuardrailG1", "GuardrailG2", "GuardrailG3"].map((name) => [name, rt.linkable(name, ["bedrock:ApplyGuardrail"])])));
  vi.doMock("./secrets", () => Object.fromEntries(SECRETS.map((name) => [name, rt.once("sst.Secret", name)])));
  const mockLinks = (fn: LambdaName) => (fn === "WorldJanitor" ? ["Dispatch", "Network"].map((name) => rt.once("sst.aws.Dynamo", name)) : [rt.linkable("NetworkMock", capabilityActions("MOCK_NETWORK"))]);
  const modules: Record<string, Record<string, unknown>> = {
    agentcore: { Harness: rt.linkable("Harness", ["bedrock-agentcore:InvokeHarness"]), Memory: rt.linkable("Memory", capabilityActions("MEMORY_ADMIN")) },
    media: { Transcribe: rt.linkable("Transcribe", capabilityActions("TRANSCRIBE")) },
    "messaging-email": { EmailChannel: rt.linkable("EmailChannel", capabilityActions("SEND_EMAIL")) },
    certificates: { CertificateWriter: rt.once("sst.aws.Function", "CertificateWriter") },
    // The contract of infra/mocks.ts: the mocks a role calls (Linkables with their capability) and the
    // mocks' tables it writes (by name, with the statement fenced by dynamodb:LeadingKeys).
    mocks: { mockLinks, mockPermissions: (fn: LambdaName) => (fn === "WorldJanitor" ? mockTableStatement(fn) : []) },
    "messaging-whatsapp": { whatsappPermissions: (fn: LambdaName) => new FakeOutput(Promise.resolve(fn === "InstallerWorker" ? [NUMBER_STATEMENT] : [])) },
    bff: { bff: rt.once("sst.aws.Function", "Bff"), qaDriver: rt.once("sst.aws.Function", "QaDriver") },
  };
  // A WP-02 stub exports nothing: every name reads as undefined.
  for (const [owner, exported] of Object.entries(modules)) vi.doMock(`./${owner}`, () => (owners === "built" ? exported : Object.fromEntries(Object.keys(exported).map((name) => [name, undefined]))));
  const workers = await import("./workers");
  const scheduler = await import("./scheduler");
  await settle(scheduler.worldJanitorPurgeInvokers);
  await Promise.all(rt.recorded.map((entry) => settle(entry.args)));
  const args = async (type: string, name: string): Promise<Record<string, unknown>> => {
    const entry = rt.recorded.find((candidate) => candidate.type === type && candidate.name === name);
    if (!entry) throw new Error(`no ${type} named ${name} was created`);
    return (await settle(entry.args)) as Record<string, unknown>;
  };
  return { ...rt, workers, scheduler, args, mocked: ["./storage-tables", "./storage-buckets", "./guardrail", "./secrets", ...Object.keys(modules).map((owner) => `./${owner}`)] };
}

const APP = "aws-cds-hackathon-poc-cuadrilla";
const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const architecture = read("docs/architecture.md");
const bootstrap = read("infra/bootstrap/ci-role.yaml");
const allow = (actions: readonly string[], resources: string[], conditions?: unknown[]) => ({ type: "aws.permission", actions: [...actions], resources, ...(conditions ? { conditions } : {}) });
/** Tables and buckets infra/iam-capabilities.ts gives a function, in the order `storageLinks` returns them. */
const stored = (fn: LambdaName): string[] => [...storageFor(fn).tables, ...storageFor(fn).buckets];
/** The statements infra/storage.ts resolves for a function, over the recorded tables and buckets. */
const storageStatements = (fn: LambdaName): Statement[] => dataAccessGrants(fn).storage.map((grant) => ({ actions: [...grant.actions], resources: grant.resources.map(arnOf) }));
const mexicoCity = (date: Date): string => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);

type Evaluated = Awaited<ReturnType<typeof evaluate>>;
let world: Evaluated;
const fnArgs = async (name: string, from: Evaluated = world): Promise<FunctionArgs> => (await from.args("sst.aws.Function", name)) as unknown as FunctionArgs;
const linkNames = (link: readonly unknown[]): string[] => link.map((item) => metaOf(item)?.name ?? "?");

/** Actions a linked item grants: a Function its invocation, a Linkable or a wrapped queue its `include`, the rest none. */
async function linkedActions(item: unknown): Promise<string[]> {
  const meta = metaOf(item);
  if (meta?.type === "sst.aws.Function") return ["lambda:InvokeFunction"];
  const wrap = meta ? world.wraps.get(meta.type) : undefined;
  const definition = wrap ? await settle(wrap(item)) : meta?.type === "sst.Linkable" ? await world.args("sst.Linkable", meta.name) : {};
  return ((definition as { include?: Statement[] }).include ?? []).flatMap((statement) => statement.actions);
}

beforeAll(async () => {
  world = await evaluate("built");
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const path of world.mocked) vi.doUnmock(path);
});

describe("numbers of docs/architecture.md and docs/build-plan.md", () => {
  it("§7 and WP-27: worker 360 s, batch 1, MaximumConcurrency 10 on the mapping; queue visibility 720 s, maxReceiveCount 5", () => {
    const { INSTALLER_WORKER: worker, INSTALLER_EVENTS: queue } = world.workers;
    const section = /`InstallerWorker` \(timeout (\d+) s, batch (\d+), event source mapping con `ScalingConfig\.MaximumConcurrency (\d+)`[\s\S]*?visibilidad (\d+) s, `maxReceiveCount (\d+)`/.exec(architecture);
    expect(section?.slice(1).map(Number)).toEqual([worker.timeoutSeconds, worker.batchSize, worker.maximumConcurrency, queue.visibilityTimeoutSeconds, queue.maxReceiveCount]);
    const plan = /`InstallerWorker` \(timeout (\d+) s, event source mapping con `ScalingConfig\.MaximumConcurrency (\d+)`, visibilidad (\d+) s, `maxReceiveCount (\d+)`\)/.exec(read("docs/build-plan.md"));
    expect(plan?.slice(1).map(Number)).toEqual([worker.timeoutSeconds, worker.maximumConcurrency, queue.visibilityTimeoutSeconds, queue.maxReceiveCount]);
    expect(queue.visibilityTimeoutSeconds).toBeGreaterThanOrEqual(2 * worker.timeoutSeconds);
  });

  it("§1 and §8: the schedules group, and WorldJanitor at 04:00 America/Mexico_City every day of the year", () => {
    const group = world.scheduler.scheduleGroupName(APP, "poc");
    expect(group).toBe(SCHEDULE_GROUP);
    expect(architecture).toContain(`| Grupo de schedules | \`${group}\` |`);
    expect(architecture).toContain("`WorldJanitor` (04:00 America/Mexico_City)");
    const hourUtc = Number(/^cron\(0 (\d+) \* \* \? \*\)$/.exec(world.scheduler.WORLD_JANITOR.nightlySchedule)?.[1]);
    for (const year of [2026, 2027]) for (let month = 0; month < 12; month += 1) for (const day of [1, 15]) expect(mexicoCity(new Date(Date.UTC(year, month, day, hourUtc)))).toBe("04:00");
  });
});

describe("handlers", () => {
  it.each(["InstallerWorker", "ChannelEvents", "FeedEvents", "ScheduleDispatch", "WorldJanitor"])("%s points at a module of packages/bff that exports its handler", async (name) => {
    const source = `${(await fnArgs(name)).handler.replace(/\.handler$/, "")}.ts`;
    expect(read(source)).toMatch(/export (const|async function|function) handler\b/);
  });
});

describe("InstallerEvents.fifo and its DLQ", () => {
  it("FIFO without content-based deduplication (producers set eventId), 720 s, SSE, fixed names, DLQ after 5 receives kept 14 days", async () => {
    expect(await world.args("sst.aws.Queue", "InstallerEvents")).toEqual({
      fifo: { contentBasedDeduplication: false },
      visibilityTimeout: "720 seconds",
      dlq: { queue: "InstallerEventsDlq.arn", retry: 5 },
      transform: { queue: { name: `${APP}-poc-InstallerEvents.fifo`, sqsManagedSseEnabled: true } },
    });
    expect(await world.args("sst.aws.Queue", "InstallerEventsDlq")).toEqual({
      fifo: true,
      transform: { queue: { name: `${APP}-poc-InstallerEventsDlq.fifo`, messageRetentionSeconds: 1_209_600, sqsManagedSseEnabled: true } },
    });
  });

  it("both names fit SQS, the CI deploy role's name fence and the QaDriver's DLQ alarm fence", () => {
    expect(bootstrap).toContain('sqs:${Region}:${AWS::AccountId}:${AppName}-*"');
    for (const queue of ["InstallerEvents", "InstallerEventsDlq"] as const) {
      const name = world.workers.queueName(APP, "poc", queue);
      expect(name.startsWith(`${APP}-`) && name.length <= 80 && /^[A-Za-z0-9_-]+\.fifo$/.test(name), name).toBe(true);
    }
    // An alarm named after the DLQ (infra/observability.ts, WP-38) is inside `alarm:<app>-poc-InstallerEventsDlq*`.
    const alarmPrefix = IAM_ARNS.dlqAlarm.slice(IAM_ARNS.dlqAlarm.indexOf(":alarm:") + ":alarm:".length, -1);
    expect(world.workers.queueName(APP, "poc", "InstallerEventsDlq").startsWith(alarmPrefix)).toBe(true);
  });

  it("linking a queue hands its url and one role, never sqs:*: SendMessage on the queue, the QaDriver's two actions on the DLQ", async () => {
    const wrap = world.wraps.get("sst.aws.Queue");
    expect(wrap).toBe(world.workers.queueLink);
    expect(await settle(wrap?.(world.workers.InstallerEvents))).toEqual({ properties: { url: "InstallerEvents.url" }, include: [allow(["sqs:SendMessage"], ["InstallerEvents.arn"])] });
    expect(await settle(wrap?.(world.workers.InstallerEventsDlq))).toEqual({ properties: { url: "InstallerEventsDlq.url" }, include: [allow(QA_DRIVER_DLQ_ONLY_ACTIONS, ["InstallerEventsDlq.arn"])] });
  });
});

describe("InstallerWorker", () => {
  it("360 s, no reserved concurrency, nothing in the environment; one event per invocation, at most 10 installers at once", async () => {
    const worker = await fnArgs("InstallerWorker");
    expect(worker).toMatchObject({ handler: "packages/bff/src/handlers/installer-worker.handler", timeout: "360 seconds", memory: "1024 MB" });
    expect(worker).not.toHaveProperty("concurrency");
    expect(worker).not.toHaveProperty("environment");
    const mapping = { eventSourceArn: "InstallerEvents.arn", functionName: "InstallerWorker.arn", batchSize: 1, scalingConfig: { maximumConcurrency: 10 } };
    expect(await world.args("aws.lambda.EventSourceMapping", "InstallerWorkerEvents")).toEqual(mapping);
  });

  it("polls InstallerEvents only; then its tables, SEND_WHATSAPP's reads and our number", async () => {
    expect((await fnArgs("InstallerWorker")).permissions).toEqual([
      { actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"], resources: ["InstallerEvents.arn"] },
      ...storageStatements("InstallerWorker"),
      { actions: ["s3:GetObject"], resources: ["Evidence.arn/certificates/*", "Evidence.arn/photos/*"] },
      NUMBER_STATEMENT,
    ]);
  });

  it("links its tables, Media and Evidence by name, the guardrails, the queue, TIMERS, the capabilities of the wave and CertificateWriter", async () => {
    expect(linkNames((await fnArgs("InstallerWorker")).link)).toEqual([
      ...stored("InstallerWorker"),
      ...["Media", "Evidence", "GuardrailG1", "GuardrailG2", "GuardrailG3", "ChannelModes", "CostCaps"],
      ...["SessionTokenKey", "WhatsAppPhoneNumberId", "SeedOverrides", "BrandConfig", "InstallerEvents"],
      ...["Scheduler", "Harness", "Transcribe", "EmailChannel", "CertificateWriter", "NetworkMock"],
    ]);
  });
});

describe("ChannelEvents, FeedEvents and ScheduleDispatch", () => {
  it.each([["ChannelEvents", "channel-events"], ["FeedEvents", "feed-events"], ["ScheduleDispatch", "schedule-dispatch"]] as const)("%s: 30 s, its tables and InstallerEvents, nothing else", async (name, file) => {
    const created = await fnArgs(name);
    expect(created).toMatchObject({ handler: `packages/bff/src/handlers/${file}.handler`, timeout: "30 seconds" });
    expect(linkNames(created.link)).toEqual([...stored(name), "InstallerEvents"]);
    expect(created.permissions).toEqual(storageStatements(name));
  });
});

describe("timers: EventBridge Scheduler (ADR-0004)", () => {
  it("one group with the fixed name, inside the CI deploy role's and the boundary's fences", async () => {
    expect(await world.args("aws.scheduler.ScheduleGroup", "Schedules")).toEqual({ name: `${APP}-poc-schedules` });
    expect(bootstrap).toContain('schedule-group/${AppName}-*"');
    expect(bootstrap).toContain('schedule/${AppName}-*/*"');
  });

  it("the invocation role: fixed name inside TIMERS' PassRole fence, trusted by the Scheduler for this account and group only", async () => {
    const role = await world.args("aws.iam.Role", "SchedulerInvocationRole");
    const name = `${APP}-poc-SchedulerInvocation`;
    expect(role.name).toBe(name);
    expect(name.length).toBeLessThanOrEqual(64);
    // infra/ci.ts puts the app's path in front of the name; a module that set path or boundary would be denied.
    const fence = new RegExp(`^${IAM_ARNS.schedulerRole.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);
    expect(`arn:aws:iam::776805327629:role/${APP}/${name}`).toMatch(fence);
    expect(role).not.toHaveProperty("path");
    expect(role).not.toHaveProperty("permissionsBoundary");
    const condition = { StringEquals: { "aws:SourceAccount": "data.accountId", "aws:SourceArn": "Schedules.arn" } };
    const trust = { Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Action: "sts:AssumeRole", Condition: condition };
    expect(JSON.parse(String(role.assumeRolePolicy))).toEqual({ Version: "2012-10-17", Statement: [trust] });
  });

  it("the invocation role may only invoke ScheduleDispatch, which names that role in its resource policy", async () => {
    const policy = await world.args("aws.iam.RolePolicy", "SchedulerInvocationPolicy");
    expect(policy.role).toBe("SchedulerInvocationRole.id");
    const only = { Sid: "InvokeScheduleDispatchOnly", Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: ["ScheduleDispatch.arn"] };
    expect(JSON.parse(String(policy.policy))).toEqual({ Version: "2012-10-17", Statement: [only] });
    const invoke = { action: "lambda:InvokeFunction", function: "ScheduleDispatch.name", principal: "SchedulerInvocationRole.arn" };
    expect(await world.args("aws.lambda.Permission", "ScheduleDispatchInvokedByScheduler")).toEqual(invoke);
  });

  it("`Scheduler` is TIMERS: the schedule actions on the group's schedules, PassRole of that role only to the Scheduler", async () => {
    const { properties, include } = (await world.args("sst.Linkable", "Scheduler")) as { properties: unknown; include: Statement[] };
    expect(properties).toEqual({ groupName: "Schedules.name", roleArn: "SchedulerInvocationRole.arn", targetArn: "ScheduleDispatch.arn" });
    expect(include).toEqual([
      allow(["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"], ["arn:aws:scheduler:data.region:data.accountId:schedule/Schedules.name/*"]),
      allow(["iam:PassRole"], ["SchedulerInvocationRole.arn"], [{ test: "StringEquals", variable: "iam:PassedToService", values: ["scheduler.amazonaws.com"] }]),
    ]);
    expect(include.flatMap((statement) => statement.actions).sort()).toEqual(capabilityActions("TIMERS").sort());
  });
});

describe("WorldJanitor", () => {
  it("15 minutes; WORLDS: its tables, Seed and Media by name, the mocks' tables fenced to guest worlds, timers and Memory", async () => {
    const janitor = await fnArgs("WorldJanitor");
    expect(janitor).toMatchObject({ handler: "packages/bff/src/handlers/world-janitor.handler", timeout: "900 seconds", memory: "512 MB" });
    expect(linkNames(janitor.link)).toEqual([...stored("WorldJanitor"), ...["Seed", "Media", "Scheduler", "SessionTokenKey", "SeedOverrides", "BrandConfig", "Memory", "Dispatch", "Network"]]);
    expect(janitor.permissions).toEqual([
      ...storageStatements("WorldJanitor"),
      { actions: ["s3:GetObject"], resources: ["Seed.arn/*"] },
      { actions: ["s3:PutObject"], resources: ["Media.arn/sim/*"] },
      ...mockTableStatement("WorldJanitor"),
    ]);
    expect(JSON.stringify(mockTableStatement("WorldJanitor"))).toContain("isp-guest-");
  });

  it("resets idle guest worlds every night with its own event, through a tagged EventBridge rule", async () => {
    expect(await world.args("sst.aws.Cron", "WorldJanitorNightly")).toEqual({ function: "WorldJanitor.arn", schedule: "cron(0 10 * * ? *)", event: { kind: "IDLE_GUEST_RESET" } });
    expect(bootstrap).toContain("- events:PutRule");
  });

  it("its resource policy admits MEMORY_PURGE only from the roles of Bff and QaDriver", async () => {
    const purge = world.recorded.filter((entry) => entry.type === "aws.lambda.Permission" && entry.name.startsWith("WorldJanitor"));
    expect(await Promise.all(purge.map((entry) => settle(entry.args)))).toEqual(["Bff", "QaDriver"].map((caller) => ({ action: "lambda:InvokeFunction", function: "WorldJanitor.name", principal: `${caller}.role.arn` })));
  });
});

describe("least privilege (docs/architecture.md §14)", () => {
  // Data access is declared as tables and buckets, not as actions; the worker's poller actions are
  // declared in infra/iam-capabilities.ts like any other grant.
  const DATA_ACCESS = /^(?:dynamodb|s3):/;
  const CASES: LambdaName[] = ["InstallerWorker", "ChannelEvents", "FeedEvents", "ScheduleDispatch", "WorldJanitor"];

  it.each(CASES)("%s ends up with exactly the actions infra/iam-capabilities.ts gives it", async (name) => {
    const created = await fnArgs(name);
    const actions = new Set(created.permissions.flatMap((statement) => statement.actions));
    for (const item of created.link) for (const action of await linkedActions(item)) actions.add(action);
    const drift = actionDrift(name, [...actions]);
    expect(drift.missing).toEqual([]);
    expect(drift.extra.filter((action) => !DATA_ACCESS.test(action))).toEqual([]);
  });

  it("every late read resolves once its owner exports it: no warning", () => expect(world.warnings).toEqual([]));

  const late = (entries: Record<string, readonly string[]>): Array<[string, string]> => Object.entries(entries).flatMap(([owner, names]) => names.map((name): [string, string] => [owner, name]));
  const LATE: Array<[string, string]> = [
    ...[["agentcore", "Harness"], ["media", "Transcribe"], ["messaging-email", "EmailChannel"], ["certificates", "CertificateWriter"], ["mocks", "mockLinks"], ["mocks", "mockPermissions"]],
    ...[["messaging-whatsapp", "whatsappPermissions"], ["agentcore", "Memory"], ["bff", "bff"], ["bff", "qaDriver"]],
  ] as Array<[string, string]>;

  it("checks every name these modules read late", () => {
    const { WORKER_LATE_LINKS, LATE_CALLS } = world.workers;
    const { JANITOR_LATE_LINKS, MEMORY_PURGE_INVOKERS } = world.scheduler;
    expect(LATE).toEqual([...late(WORKER_LATE_LINKS), ...late(LATE_CALLS), ...late(JANITOR_LATE_LINKS), ...late({ bff: Object.values(MEMORY_PURGE_INVOKERS) })]);
  });

  // Once an owner stops being a WP-02 stub, its real source has to export the name, or the deploy only warns.
  it.each(LATE)("infra/%s.ts exports %s once it is built", (owner, name) => {
    const source = read(`infra/${owner}.ts`);
    const built = !/^\/\/ Stub created by WP-\d/m.test(source);
    expect(built ? new RegExp(`export (?:const|function) ${name}\\b`).test(source) : true, `infra/${owner}.ts`).toBe(true);
  });
});

describe("while the owners are still WP-02 stubs", () => {
  let stubs: Evaluated;
  beforeAll(async () => {
    stubs = await evaluate("stubs");
  });

  it("the deploy only warns, and the functions go without what those owners bring", async () => {
    expect(linkNames((await fnArgs("InstallerWorker", stubs)).link).slice(-2)).toEqual(["InstallerEvents", "Scheduler"]);
    expect((await fnArgs("InstallerWorker", stubs)).permissions).toHaveLength(1 + storageStatements("InstallerWorker").length + 1);
    expect(linkNames((await fnArgs("WorldJanitor", stubs)).link).slice(-1)).toEqual(["BrandConfig"]);
    expect(stubs.recorded.filter((entry) => entry.type === "aws.lambda.Permission").map((entry) => entry.name)).toEqual(["ScheduleDispatchInvokedByScheduler"]);
    const names = ["Harness", "Transcribe", "EmailChannel", "Memory", "mockLinks", "mockPermissions", "whatsappPermissions", "bff", "qaDriver"];
    for (const name of names) expect(stubs.warnings.some((warning) => warning.includes(` exports no ${name} yet`)), name).toBe(true);
  });
});
