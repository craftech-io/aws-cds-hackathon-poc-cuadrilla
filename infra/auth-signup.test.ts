// The own sign-up as the infra builds it (ADR-0025 §1 and §3, docs/test-plan.md §3): infra/bff.ts is
// evaluated, with infra/web.ts, infra/auth.ts, infra/leads.ts and infra/guest-worlds.ts behind it,
// against a recording fake of the SST globals. What is asserted is what the modules hand to Cognito,
// Lambda and CloudFront, not their source text. The storage, the mocks, the Memory and the world
// templates are stand-ins (their own tests cover them).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POOL_CLIENTS, userPoolSettings } from "./auth-email";
import { expectedGrants, type Grant, type LambdaName } from "./iam-capabilities";
import { BFF_LEADS_GRANT, SIGNUP_HANDLERS, guestAccountDeletionName } from "./leads-spec";

class Out {
  readonly promise: Promise<unknown>;
  constructor(promise: Promise<unknown>) {
    this.promise = promise;
    promise.catch(() => undefined);
  }
  apply(fn: (value: never) => unknown): Out {
    return new Out(this.promise.then((value) => settle(fn(value as never))));
  }
}
const settle = (value: unknown): unknown => (value instanceof Out ? value.promise : value);
const out = (value: unknown): Out => (value instanceof Out ? value : new Out(Promise.resolve(value).then(settle)));

async function deep(value: unknown): Promise<unknown> {
  if (value instanceof Out) return deep(await value.promise);
  if (Array.isArray(value)) return Promise.all(value.map(deep));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, inner]) => [key, await deep(inner)] as const)));
  }
  return value;
}

interface Created {
  readonly type: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

const ACCOUNT = "111111111111";
const created: Created[] = [];
const record = (type: string, name: string, args: unknown) => void created.push({ type, name, args: args as Record<string, unknown> });
const arnOf = (kind: string, name: string) => `arn:aws:${kind}:us-east-1:${ACCOUNT}:${name}`;

class Named {
  readonly arn: Out;
  readonly name: Out;
  constructor(readonly logical: string, kind = "dynamodb") {
    this.arn = out(arnOf(kind, `table/${logical}`));
    this.name = out(logical);
  }
}
class Fn {
  readonly arn: Out;
  readonly nodes = { role: { arn: out("role") }, logGroup: out({ name: "log" }) };
  constructor(readonly logical: string, args: unknown) {
    record("sst.aws.Function", logical, args);
    this.arn = out(arnOf("lambda", `function:${logical}`));
  }
}
class Pool {
  readonly id = out("us-east-1_POOL");
  readonly arn = out(arnOf("cognito-idp", "userpool/us-east-1_POOL"));
  constructor(name: string, args: unknown) {
    record("sst.aws.CognitoUserPool", name, args);
  }
  addClient(name: string, args: unknown) {
    record("client", name, args);
    return { id: out(`client-${name}`) };
  }
}
class Dynamo extends Named {
  readonly nodes = { table: { streamArn: out(arnOf("dynamodb", "table/Leads/stream/1")) } };
  constructor(name: string, args: unknown) {
    super(name);
    record("sst.aws.Dynamo", name, args);
  }
}
const recorder = (type: string, extra: Record<string, unknown> = {}) =>
  class {
    constructor(name: string, args: unknown) {
      record(type, name, args);
      Object.assign(this, { arn: out(arnOf(type, name)), ...extra });
    }
  };

const TABLES = Object.fromEntries(["Isps", "People", "WorkOrders", "Cases", "Conversations", "AuditLog", "Reference", "Runtime", "CuadrillaMetrics"].map((name) => [name, new Named(name)]));
const BUCKETS = Object.fromEntries(["Media", "Evidence", "Manual", "Seed"].map((name) => [name, new Named(name, "s3")]));
const SENTINELS = { Memory: { sentinel: "Memory" }, WorldTemplates: { sentinel: "WorldTemplates" }, CostCaps: { sentinel: "CostCaps" } };

let modules: { bff: Record<string, unknown>; auth: Record<string, unknown>; leads: Record<string, unknown> };

beforeAll(async () => {
  vi.resetModules();
  vi.stubGlobal("$app", { name: "aws-cds-hackathon-poc-cuadrilla", stage: "poc" });
  vi.stubGlobal("$util", { output: out, all: (values: unknown[]) => new Out(Promise.all(values.map((value) => out(value).promise))), log: { warn: vi.fn() }, jsonStringify: (value: unknown) => out(value) });
  vi.stubGlobal("$interpolate", (parts: TemplateStringsArray, ...values: unknown[]) => new Out(Promise.all(values.map((value) => out(value).promise)).then((resolved) => parts.reduce((text, part, i) => `${text}${part}${i < resolved.length ? String(resolved[i]) : ""}`, ""))));
  vi.stubGlobal("sst", {
    Secret: class {
      constructor(readonly name: string) {}
      get value() {
        return out(`value-of-${this.name}`);
      }
    },
    Linkable: recorder("sst.Linkable"),
    aws: { Function: Fn, CognitoUserPool: Pool, Dynamo, Queue: recorder("sst.aws.Queue"), Cron: recorder("sst.aws.Cron"), Router: recorder("sst.aws.Router"), StaticSite: recorder("sst.aws.StaticSite"), dns: () => ({}), permission: (args: unknown) => ({ permission: args }) },
  });
  vi.stubGlobal("aws", {
    getRegionOutput: () => ({ region: out("us-east-1") }),
    getCallerIdentityOutput: () => ({ accountId: out(ACCOUNT) }),
    cognito: { UserGroup: recorder("aws.cognito.UserGroup") },
    sesv2: { EmailIdentity: { isInstance: () => false } },
    lambda: { EventSourceMapping: recorder("aws.lambda.EventSourceMapping") },
    cloudwatch: { MetricAlarm: recorder("aws.cloudwatch.MetricAlarm") },
    wafv2: { WebAcl: recorder("aws.wafv2.WebAcl", { applicationIntegrationUrl: out("https://abc.edge.sdk.awswaf.com/abc/def/") }), WebAclAssociation: recorder("aws.wafv2.WebAclAssociation") },
    cloudfront: {
      KeyValueStore: { get: () => ({ arn: out("kvs") }) },
      getResponseHeadersPolicyOutput: () => ({ id: out("headers-policy") }),
      getOriginRequestPolicyOutput: (args: { name: string }) => ({ id: out(args.name === "aws-cds-hackathon-poc-cuadrilla-poc-api" ? "api-policy" : undefined) }),
      getCachePolicyOutput: (args: { name: string }) => ({ id: out(args.name === "aws-cds-hackathon-poc-cuadrilla-poc-api" ? "api-cache-policy" : undefined) }),
    },
  });
  vi.doMock("./storage-tables", () => ({ ...TABLES, tables: TABLES }));
  vi.doMock("./storage-buckets", () => ({ buckets: BUCKETS, mediaBucket: BUCKETS.Media, evidenceBucket: BUCKETS.Evidence, manualBucket: BUCKETS.Manual, seedBucket: BUCKETS.Seed }));
  vi.doMock("./messaging-email", () => ({ emailIdentity: undefined }));
  vi.doMock("./mocks", () => ({ mockLinks: () => [], mockPermissions: () => [] }));
  vi.doMock("./agentcore", () => ({ Memory: SENTINELS.Memory }));
  vi.doMock("./world-templates", () => ({ WorldTemplates: SENTINELS.WorldTemplates }));
  vi.doMock("./cost-caps", () => ({ CostCaps: SENTINELS.CostCaps }));
  // In the order of sst.config.ts: the leads before the pool, whose ARN they read late.
  const leads = await import("./leads");
  modules = { leads, bff: await import("./bff"), auth: await import("./auth") };
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const module of ["./storage-tables", "./storage-buckets", "./messaging-email", "./mocks", "./agentcore", "./world-templates", "./cost-caps"]) vi.doUnmock(module);
});

const fn = (name: string): Created => {
  const found = created.find((entry) => entry.type === "sst.aws.Function" && entry.name === name);
  expect(found, name).toBeDefined();
  return found as Created;
};

// The ARN each placeholder of the flow's grants stands for in this runtime.
const LEADS_ARN = arnOf("dynamodb", "table/Leads");
const PLACEHOLDERS: Record<string, string> = {
  "{Leads}": LEADS_ARN,
  "{Leads}/index/*": `${LEADS_ARN}/index/*`,
  "{Leads}/stream/*": `${LEADS_ARN}/stream/*`,
  "{Runtime}": arnOf("dynamodb", "table/Runtime"),
  "{Isps}": arnOf("dynamodb", "table/Isps"),
  "{Isps}/index/*": `${arnOf("dynamodb", "table/Isps")}/index/*`,
  "{UserPool}": arnOf("cognito-idp", "userpool/us-east-1_POOL"),
};
const resolved = (grant: Grant) => ({
  actions: [...grant.actions],
  resources: grant.resources.map((resource) => PLACEHOLDERS[resource] ?? resource),
  ...(grant.conditions ? { conditions: grant.conditions.map((condition) => ({ ...condition, values: [...condition.values] })) } : {}),
});
const flowGrants = (name: LambdaName) => expectedGrants(name).filter((grant) => !grant.resources.every((resource) => ["{GuestWorlds}", "{GuestAccountDeletion}"].includes(resource)));

describe("own sign-up in the user pool (ADR-0025 §1) [FL-104]", () => {
  it("is open, only through the pre sign-up's ticket, and never applies an email change before verifying it", async () => {
    const pool = created.find((entry) => entry.type === "sst.aws.CognitoUserPool") as Created;
    const settings = (await deep((pool.args.transform as { userPool: unknown }).userPool)) as Record<string, { allowAdminCreateUserOnly?: boolean }>;
    expect(settings.adminCreateUserConfig?.allowAdminCreateUserOnly).toBe(false);
    expect(settings.userAttributeUpdateSettings).toEqual(userPoolSettings().userAttributeUpdateSettings);
    expect(((await deep(pool.args.triggers)) as Record<string, unknown>).preSignUp).toBe(arnOf("lambda", "function:AuthPreSignUp"));
  });

  it("has three public clients with explicit attributes: ConsoleWeb, GuestSignup and QaProbe", () => {
    const clients = created.filter((entry) => entry.type === "client");
    expect(clients.map((entry) => entry.name)).toEqual(["ConsoleWeb", "GuestSignup", "QaProbe"]);
    for (const client of clients) {
      const settings = (client.args.transform as { client: Record<string, unknown> }).client;
      expect(settings).toEqual(POOL_CLIENTS[client.name as keyof typeof POOL_CLIENTS]);
      expect(settings).toMatchObject({ generateSecret: false, allowedOauthFlowsUserPoolClient: false, allowedOauthFlows: [], callbackUrls: [], preventUserExistenceErrors: "ENABLED" });
      for (const attribute of [...(settings.writeAttributes as string[]), ...(settings.readAttributes as string[])]) if (client.name !== "ConsoleWeb") expect(attribute).not.toMatch(/^custom:/);
      for (const attribute of settings.writeAttributes as string[]) expect(attribute).not.toMatch(/^custom:/);
    }
    const [web, signup, qa] = clients.map((entry) => (entry.args.transform as { client: Record<string, unknown> }).client);
    expect([web?.explicitAuthFlows, web?.writeAttributes]).toEqual([["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"], ["name"]]);
    expect([signup?.explicitAuthFlows, signup?.writeAttributes, signup?.readAttributes]).toEqual([["ALLOW_REFRESH_TOKEN_AUTH"], ["email", "name", "locale"], ["email", "email_verified", "name", "locale"]]);
    expect([qa?.explicitAuthFlows, qa?.writeAttributes, qa?.readAttributes, qa?.accessTokenValidity]).toEqual([["ALLOW_ADMIN_USER_PASSWORD_AUTH"], [], ["email", "email_verified"], 5]);
  });
});

describe("triggers of the pool (fixed names, WP-57 and WP-58 handlers) [FL-104] [FL-114]", () => {
  const TRIGGERS = ["AuthPreSignUp", "AuthCustomMessage", "AuthPostConfirmation", "AuthPostAuthentication"] as const;

  it.each(TRIGGERS)("runs %s from its handler within Cognito's 5 seconds", (name) => {
    expect(fn(name).args).toMatchObject({ handler: SIGNUP_HANDLERS[name], timeout: "5 seconds", memory: "256 MB" });
    expect(fn(name).args).not.toHaveProperty("environment");
  });

  it.each(TRIGGERS)("grants %s exactly its row, resolved, and no Cognito action", async (name) => {
    const permissions = (await deep(fn(name).args.permissions)) as Array<{ actions: string[] }>;
    expect(permissions).toEqual(flowGrants(name).map(resolved));
    for (const statement of permissions) for (const action of statement.actions) expect(action).not.toMatch(/^cognito-idp:|^ses:|^bedrock/);
  });

  it("links each trigger to what its code reads, and nothing else", async () => {
    const links = async (name: string) => ((await deep(fn(name).args.link)) as unknown[]).map((item) => (item instanceof Named ? item.logical : ((item as { name?: string }).name ?? (item as { logical?: string }).logical ?? item)));
    const leads = modules.leads.Leads;
    expect(await links("AuthCustomMessage")).toEqual(["Runtime"]);
    const preSignUp = (await deep(fn("AuthPreSignUp").args.link)) as unknown[];
    expect(preSignUp).toContain(leads);
    expect(await links("AuthPreSignUp")).toEqual(expect.arrayContaining(["Runtime", "SessionTokenKey"]));
    for (const name of ["AuthPostConfirmation", "AuthPostAuthentication"]) {
      const list = (await deep(fn(name).args.link)) as unknown[];
      expect(list, name).toEqual(expect.arrayContaining([leads, TABLES.Isps, TABLES.Runtime, SENTINELS.CostCaps]));
      expect(list.some((item) => item instanceof Fn && item.logical === "GuestWorlds"), name).toBe(true);
      // Both hash the confirmed email into the lead's key (the sign-in resumes a failed confirmation).
      expect(await links(name), name).toContain("SessionTokenKey");
    }
  });
});

describe("the edge of the Bff (ADR-0025 §3) [FL-114]", () => {
  const router = () => created.find((entry) => entry.type === "sst.aws.Router") as Created;
  const DEFAULT = { targetOriginId: "default", cachePolicyId: "sst-cache", originRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac", functionAssociations: [{ eventType: "viewer-request", functionArn: "router-fn" }] };
  const transformed = async () => {
    const args: Record<string, unknown> = { origins: [{ originId: "default", domainName: "placeholder.sst.dev" }], defaultCacheBehavior: DEFAULT };
    (router().args.transform as { cdn: (args: Record<string, unknown>) => void }).cdn(args);
    return (await deep(args)) as { origins: Array<{ customHeaders: unknown }>; webAclArn: string; defaultCacheBehavior: Record<string, unknown>; orderedCacheBehaviors: Array<Record<string, unknown>> };
  };

  it("adds x-cuadrilla-origin with OriginVerifyKey to every origin request, over a viewer's own", async () => {
    const { origins } = await transformed();
    expect(origins[0]?.customHeaders).toEqual([{ name: "x-cuadrilla-origin", value: "value-of-OriginVerifyKey" }]);
  });

  it("serves /api/* with the default routing, the bootstrap's policy that forwards CloudFront-Viewer-Address and the cache policy that keeps Authorization on a GET", async () => {
    const { orderedCacheBehaviors, defaultCacheBehavior } = await transformed();
    expect(orderedCacheBehaviors).toEqual([{ ...DEFAULT, pathPattern: "/api/*", originRequestPolicyId: "api-policy", cachePolicyId: "api-cache-policy", responseHeadersPolicyId: "headers-policy" }]);
    expect(defaultCacheBehavior).toEqual({ ...DEFAULT, responseHeadersPolicyId: "headers-policy" });
  });

  it("puts the edge web ACL on the distribution", async () => {
    expect((await transformed()).webAclArn).toBe(arnOf("aws.wafv2.WebAcl", "EdgeWebAcl"));
  });

  it("builds the Bff behind /api with a public URL, no CORS, its budget and the origin key", async () => {
    const bff = fn("Bff");
    const url = bff.args.url as { authorization: string; cors: boolean; router: { path: string; readTimeout: string } };
    expect([url.authorization, url.cors, url.router.path, url.router.readTimeout]).toEqual(["none", false, "/api", "30 seconds"]);
    expect(bff.args).toMatchObject({ handler: "packages/bff/src/routers/handler.handler", timeout: "28 seconds", memory: "1024 MB", concurrency: { reserved: 10 } });
    const link = (await deep(bff.args.link)) as Array<{ name?: string; logical?: string }>;
    for (const name of ["OriginVerifyKey", "SessionTokenKey", "BrandConfig"]) expect(link.map((item) => item.name), name).toContain(name);
    for (const name of ["Leads", "Runtime", "GuestWorlds", "GuestAccountDeletion"]) expect(link.map((item) => item.logical), name).toContain(name);
    const permissions = (await deep(bff.args.permissions)) as unknown[];
    expect(permissions).toContainEqual(resolved(BFF_LEADS_GRANT));
    expect(JSON.stringify(permissions)).not.toMatch(/"(ses|social-messaging|bedrock|cognito-idp):/);
  });
});

describe("leads' Lambdas", () => {
  it("names the account deletion by its fixed name and grants LeadStream and the deletion their rows on the pool", async () => {
    expect(fn("GuestAccountDeletion").args.name).toBe(guestAccountDeletionName());
    const stream = (await deep(fn("LeadStream").args.permissions)) as unknown[];
    const withDlq: Record<string, string> = { ...PLACEHOLDERS, "{LeadStreamDlq}": arnOf("sst.aws.Queue", "LeadStreamDlq") };
    expect(stream).toEqual(flowGrants("LeadStream").filter((grant) => !grant.actions.includes("ses:SendEmail")).map((grant) => ({ ...resolved(grant), resources: grant.resources.map((resource) => withDlq[resource] ?? resource) })));
    const deletion = JSON.stringify(await deep(fn("GuestAccountDeletion").args.permissions));
    expect(deletion).toContain('"cognito-idp:AdminGetUser","cognito-idp:AdminDeleteUser"');
    expect(deletion).not.toContain("ListUsers");
  });
});
