// infra/auth.ts only evaluates inside the SST program ($app, sst, aws, $util, $interpolate), so this
// test evaluates it against a recording fake of those globals: every component it creates is kept
// with its arguments, and every Output is a promise the test resolves. What is asserted is what the
// module actually hands to Cognito, not its source text.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSOLE_GROUPS, WEB_CLIENT_SETTINGS, WEB_ENV_NAMES, cognitoMessages, emailBrandFrom, userPoolSettings } from "./auth-email";

const APP_DOMAIN = "cuadrilla.demo.craftech.io";
const POOL_ID = "us-east-1_TESTPOOL1";
const POOL_ARN = `arn:aws:cognito-idp:us-east-1:111111111111:userpool/${POOL_ID}`;
const IDENTITY_ARN = `arn:aws:ses:us-east-1:111111111111:identity/${APP_DOMAIN}`;
const NEUTRAL = JSON.stringify({ mode: "neutral" });
const PARTNER = "Design Partner Fibra";
const COBRAND = JSON.stringify({
  mode: "cobrand",
  partnerDisplayName: PARTNER,
  partnerShortName: "Partner",
  logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" },
  disclaimer: { es: `Demo sintética: datos inventados, no son las políticas reales de ${PARTNER}.`, en: "Synthetic demo." },
});

// ---- A recording SST runtime ----------------------------------------------------------------------

class FakeOutput {
  readonly promise: Promise<unknown>;
  constructor(promise: Promise<unknown>) {
    this.promise = promise;
    // Rejections surface where the test awaits them, never as unhandled.
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
  readonly brandConfig: string;
  /** The SES identity infra/messaging-email.ts exports, as the deploy reads it; absent while it is a stub. */
  readonly identity?: { readonly domain: string; readonly verified: boolean };
}

function fakeRuntime(scenario: Scenario) {
  const created: Created[] = [];
  const identityReads: Array<{ args: unknown; opts: unknown }> = [];
  const warn = vi.fn();
  const record = (type: string, name: string, args: unknown): Created => {
    const entry = { type, name, args: args as Record<string, unknown> };
    created.push(entry);
    return entry;
  };

  class EmailIdentity {
    constructor(readonly emailIdentity: string) {}
    static isInstance(value: unknown): boolean {
      return value instanceof EmailIdentity;
    }
  }

  const sst = {
    Secret: class {
      constructor(readonly name: string) {}
      get value(): FakeOutput {
        return output(this.name === "BrandConfig" ? scenario.brandConfig : `value-of-${this.name}`);
      }
    },
    Linkable: class {
      constructor(name: string, args: unknown) {
        record("sst.Linkable", name, args);
      }
    },
    aws: {
      dns: (args: unknown) => ({ dns: args }),
      Function: class {
        readonly arn: FakeOutput;
        constructor(name: string, args: unknown) {
          record("sst.aws.Function", name, args);
          this.arn = output(`arn:aws:lambda:us-east-1:111111111111:function:${name}`);
        }
      },
      CognitoUserPool: class {
        readonly id = output(POOL_ID);
        readonly arn = output(POOL_ARN);
        constructor(name: string, args: unknown) {
          record("sst.aws.CognitoUserPool", name, args);
        }
        addClient(name: string, args: unknown) {
          record("sst.aws.CognitoUserPoolClient", name, args);
          return { id: output(`client-${name}`) };
        }
      },
    },
  };

  const aws = {
    getRegionOutput: () => ({ region: output("us-east-1") }),
    cognito: {
      UserGroup: class {
        constructor(name: string, args: unknown) {
          record("aws.cognito.UserGroup", name, args);
        }
      },
    },
    sesv2: {
      EmailIdentity,
      getEmailIdentityOutput: (args: { emailIdentity: string }, opts: unknown) => {
        identityReads.push({ args, opts });
        return output({ emailIdentity: args.emailIdentity, arn: IDENTITY_ARN, verifiedForSendingStatus: scenario.identity?.verified ?? false });
      },
    },
  };

  const util = {
    output,
    all: (values: unknown[]) => new FakeOutput(Promise.all(values.map((value) => output(value).promise))),
    log: { warn },
  };

  const interpolate = (strings: TemplateStringsArray, ...values: unknown[]) =>
    new FakeOutput(Promise.all(values.map((value) => output(value).promise)).then((parts) => strings.reduce((text, piece, i) => `${text}${piece}${i < parts.length ? String(parts[i]) : ""}`, "")));

  const identity = scenario.identity ? new EmailIdentity(scenario.identity.domain) : undefined;
  return { sst, aws, util, interpolate, identity, created, identityReads, warn };
}

/** Resolves every Output inside plain objects and arrays. */
async function resolveDeep(value: unknown): Promise<unknown> {
  if (value instanceof FakeOutput) return resolveDeep(await value.promise);
  if (Array.isArray(value)) return Promise.all(value.map(resolveDeep));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = await Promise.all(Object.entries(value).map(async ([key, inner]) => [key, await resolveDeep(inner)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

// Tables and buckets of infra/storage.ts as the real module sees them: an ARN and a name. Instances of
// a class, so `resolveDeep` keeps them as they are and a link can be compared by identity.
class FakeStorage {
  readonly arn: FakeOutput;
  readonly name: FakeOutput;
  constructor(readonly logical: string, service: "dynamodb" | "s3") {
    this.arn = output(service === "dynamodb" ? `arn:aws:dynamodb:us-east-1:111111111111:table/${logical}` : `arn:aws:s3:::${logical.toLowerCase()}`);
    this.name = output(logical);
  }
}

const TABLE_NAMES = ["Isps", "People", "WorkOrders", "Cases", "Conversations", "AuditLog", "Reference", "Runtime", "CuadrillaMetrics"] as const;
const TABLES = Object.fromEntries(TABLE_NAMES.map((name) => [name, new FakeStorage(name, "dynamodb")])) as Record<(typeof TABLE_NAMES)[number], FakeStorage>;
const BUCKETS = { Media: new FakeStorage("Media", "s3"), Evidence: new FakeStorage("Evidence", "s3"), Manual: new FakeStorage("Manual", "s3"), Seed: new FakeStorage("Seed", "s3") };
const tableArn = (name: string): string => `arn:aws:dynamodb:us-east-1:111111111111:table/${name}`;

async function evaluate(scenario: Scenario) {
  const runtime = fakeRuntime(scenario);
  vi.resetModules();
  vi.stubGlobal("$app", { name: "aws-cds-hackathon-poc-cuadrilla", stage: "poc" });
  vi.stubGlobal("sst", runtime.sst);
  vi.stubGlobal("aws", runtime.aws);
  vi.stubGlobal("$util", runtime.util);
  vi.stubGlobal("$interpolate", runtime.interpolate);
  // infra/storage.ts itself is real: its links and permissions are what the trigger gets.
  vi.doMock("./storage-tables", () => ({ ...TABLES, tables: TABLES }));
  vi.doMock("./storage-buckets", () => ({
    buckets: BUCKETS,
    mediaBucket: BUCKETS.Media,
    evidenceBucket: BUCKETS.Evidence,
    manualBucket: BUCKETS.Manual,
    seedBucket: BUCKETS.Seed,
  }));
  // `undefined` while infra/messaging-email.ts is still the stub that exports nothing (WP-20).
  vi.doMock("./messaging-email", () => ({ emailIdentity: runtime.identity }));
  const module = await import("./auth");
  const only = (type: string): Created => {
    const matching = runtime.created.filter((entry) => entry.type === type);
    expect(matching, type).toHaveLength(1);
    return matching[0] as Created;
  };
  return { ...runtime, module, only };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("./storage-tables");
  vi.doUnmock("./storage-buckets");
  vi.doUnmock("./messaging-email");
});

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const URLS = { loginUrl: `https://${APP_DOMAIN}/login`, brandUrl: `https://${APP_DOMAIN}/brand` };

// ---- What infra/auth.ts creates -------------------------------------------------------------------

describe("infra/auth.ts on a recording SST runtime [FL-079]", () => {
  it("creates one pool, its three groups, one web client, the trigger and the Auth link, and nothing else", async () => {
    const { created } = await evaluate({ brandConfig: NEUTRAL });
    const count = (type: string) => created.filter((entry) => entry.type === type).length;
    expect(created.map((entry) => entry.type).sort()).toEqual(
      ["aws.cognito.UserGroup", "aws.cognito.UserGroup", "aws.cognito.UserGroup", "sst.Linkable", "sst.aws.CognitoUserPool", "sst.aws.CognitoUserPoolClient", "sst.aws.Function"].sort(),
    );
    expect(count("sst.aws.CognitoUserPool")).toBe(1);
  });

  it("builds a pool without self sign-up or hosted UI: email alias, optional TOTP, V2_0 pre token trigger", async () => {
    const { only } = await evaluate({ brandConfig: NEUTRAL });
    const pool = only("sst.aws.CognitoUserPool").args;
    expect(pool).toMatchObject({ aliases: ["email"], mfa: "optional", softwareToken: true });
    expect(pool).not.toHaveProperty("usernames");
    expect(pool).not.toHaveProperty("domain");
    expect(pool).not.toHaveProperty("verify");
    const triggers = (await resolveDeep(pool.triggers)) as Record<string, unknown>;
    expect(triggers).toEqual({ preTokenGeneration: "arn:aws:lambda:us-east-1:111111111111:function:AuthPreToken", preTokenGenerationVersion: "v2" });
  });

  it("lays the settings and the branded messages of infra/auth-email.ts over SST's pool defaults", async () => {
    const { only, warn } = await evaluate({ brandConfig: NEUTRAL });
    const transform = only("sst.aws.CognitoUserPool").args.transform as { userPool: unknown };
    const userPool = await resolveDeep(transform.userPool);
    expect(userPool).toEqual({
      ...userPoolSettings(),
      ...cognitoMessages({ ...URLS, brand: emailBrandFrom(NEUTRAL) }),
      emailConfiguration: { emailSendingAccount: "COGNITO_DEFAULT" },
    });
    expect((userPool as { adminCreateUserConfig: { allowAdminCreateUserOnly: boolean } }).adminCreateUserConfig.allowAdminCreateUserOnly).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("infra/messaging-email.ts exports no emailIdentity yet"));
  });

  it("gives the web client SRP only, 15-minute tokens and writeAttributes [name], never custom:*", async () => {
    const { only } = await evaluate({ brandConfig: NEUTRAL });
    const client = only("sst.aws.CognitoUserPoolClient");
    expect(client.name).toBe("ConsoleWeb");
    const settings = (client.args.transform as { client: typeof WEB_CLIENT_SETTINGS }).client;
    expect(settings).toEqual(WEB_CLIENT_SETTINGS);
    expect(settings.writeAttributes).toEqual(["name"]);
    for (const attribute of settings.writeAttributes) expect(attribute.startsWith("custom:")).toBe(false);
    expect(settings.explicitAuthFlows).toEqual(["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]);
    expect([settings.idTokenValidity, settings.accessTokenValidity, settings.tokenValidityUnits.idToken]).toEqual([15, 15, "minutes"]);
  });

  it("creates the groups SUPERVISOR, GUEST and OPS on the pool, with their precedence", async () => {
    const { created } = await evaluate({ brandConfig: NEUTRAL });
    const groups = await Promise.all(created.filter((entry) => entry.type === "aws.cognito.UserGroup").map((entry) => resolveDeep(entry.args)));
    expect(groups).toEqual(
      Object.entries(CONSOLE_GROUPS).map(([name, group]) => ({ userPoolId: POOL_ID, name, precedence: group.precedence, description: group.description })),
    );
  });

  it("runs the pre token trigger within Cognito's 5 seconds, linked only to Isps and AuditLog", async () => {
    const { only, module } = await evaluate({ brandConfig: NEUTRAL });
    const trigger = only("sst.aws.Function");
    expect(trigger.name).toBe("AuthPreToken");
    expect(trigger.args).toMatchObject({ handler: "packages/bff/src/auth-triggers/pre-token.handler", timeout: "5 seconds", memory: "256 MB" });
    expect(module.PRE_TOKEN_HANDLER).toBe(trigger.args.handler);
    const link = (await resolveDeep(trigger.args.link)) as unknown[];
    expect(link).toHaveLength(2);
    expect(link[0]).toBe(TABLES.AuditLog);
    expect(link[1]).toBe(TABLES.Isps);
    expect(trigger.args).not.toHaveProperty("environment");
    const architecture = read("docs/architecture.md");
    for (const table of ["Isps", "AuditLog"]) expect(architecture, table).toContain(`| \`${table}\` |`);
    expect(architecture).toContain("| `AuthPreToken` |");
  });

  it("[SEC-W1-02] lets the trigger query Isps and its GSIs and append to AuditLog, and nothing else", async () => {
    const { only } = await evaluate({ brandConfig: NEUTRAL });
    const permissions = await resolveDeep(only("sst.aws.Function").args.permissions);
    expect(permissions).toEqual([
      { actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"], resources: [tableArn("Isps"), `${tableArn("Isps")}/index/*`] },
      { actions: ["dynamodb:PutItem"], resources: [tableArn("AuditLog")] },
    ]);
    const actions = (permissions as Array<{ actions: string[] }>).flatMap((statement) => statement.actions);
    for (const action of actions) expect(action).not.toMatch(/\*|UpdateItem|DeleteItem|DeleteTable|UpdateTable|BatchWriteItem/);
  });

  it("points the trigger at a module of packages/bff that exports its handler", () => {
    const source = "packages/bff/src/auth-triggers/pre-token.ts";
    expect(existsSync(resolve(process.cwd(), source)), source).toBe(true);
    expect(read(source)).toMatch(/export (const|async function|function) handler\b|export \{[^}]*\bhandler\b[^}]*\}/);
  });

  it("links exactly what packages/bff/src/auth/config.ts reads, and grants nothing", async () => {
    const { only } = await evaluate({ brandConfig: NEUTRAL });
    const link = only("sst.Linkable");
    expect(link.name).toBe("Auth");
    expect(link.args).not.toHaveProperty("include");
    const config = read("packages/bff/src/auth/config.ts");
    const start = config.search(/z\s*\.object\(\{/);
    const schema = config.slice(start, config.indexOf("})", start));
    const bffKeys = [...schema.matchAll(/^\s*(\w+)\s*:/gm)].map((match) => match[1]);
    expect(bffKeys.length).toBeGreaterThan(0);
    const properties = (await resolveDeep(link.args.properties)) as Record<string, string>;
    expect(Object.keys(properties).sort()).toEqual([...bffKeys].sort());
    expect(properties).toEqual({
      userPoolId: POOL_ID,
      clientId: "client-ConsoleWeb",
      issuerUrl: `https://cognito-idp.us-east-1.amazonaws.com/${POOL_ID}`,
      region: "us-east-1",
    });
  });

  it("hands the console the pool id and the client id at build time", async () => {
    const { module } = await evaluate({ brandConfig: NEUTRAL });
    expect(await resolveDeep(module.authWebEnvironment)).toEqual({ [WEB_ENV_NAMES.userPoolId]: POOL_ID, [WEB_ENV_NAMES.clientId]: "client-ConsoleWeb" });
  });
});

describe("sender and brand of the console emails", () => {
  const emailConfigurationOf = async (created: Created[]) => {
    const pool = created.find((entry) => entry.type === "sst.aws.CognitoUserPool");
    const transform = pool?.args.transform as { userPool: { emailConfiguration: unknown } };
    return resolveDeep(transform.userPool.emailConfiguration);
  };

  it("sends from Cuadrilla <no-reply@> through the verified SES identity, read live after it exists", async () => {
    const { created, identity, identityReads, warn } = await evaluate({ brandConfig: NEUTRAL, identity: { domain: APP_DOMAIN, verified: true } });
    expect(await emailConfigurationOf(created)).toEqual({
      emailSendingAccount: "DEVELOPER",
      sourceArn: IDENTITY_ARN,
      fromEmailAddress: `Cuadrilla <no-reply@${APP_DOMAIN}>`,
    });
    expect(identityReads).toEqual([{ args: { emailIdentity: APP_DOMAIN }, opts: { dependsOn: [identity] } }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps Cognito's sender, with a warning, while the identity is not verified", async () => {
    const { created, warn } = await evaluate({ brandConfig: NEUTRAL, identity: { domain: APP_DOMAIN, verified: false } });
    expect(await emailConfigurationOf(created)).toEqual({ emailSendingAccount: "COGNITO_DEFAULT" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not verified for sending yet"));
  });

  it("fails the deploy when the exported identity is of another domain", async () => {
    const { created } = await evaluate({ brandConfig: NEUTRAL, identity: { domain: `mail.${APP_DOMAIN}`, verified: true } });
    await expect(emailConfigurationOf(created)).rejects.toThrow(/console emails are sent from/);
  });

  it("brands both templates as Cuadrilla for <partner> in co-branding", async () => {
    const { only } = await evaluate({ brandConfig: COBRAND });
    const transform = only("sst.aws.CognitoUserPool").args.transform as { userPool: unknown };
    const userPool = (await resolveDeep(transform.userPool)) as ReturnType<typeof cognitoMessages>;
    const expected = cognitoMessages({ ...URLS, brand: emailBrandFrom(COBRAND) });
    expect(userPool.adminCreateUserConfig).toEqual(expected.adminCreateUserConfig);
    expect(userPool.verificationMessageTemplate).toEqual(expected.verificationMessageTemplate);
    expect(userPool.adminCreateUserConfig.inviteMessageTemplate.emailSubject).toContain(`Cuadrilla for ${PARTNER}`);
  });

  it("fails the deploy on a BrandConfig that does not parse, without printing it", async () => {
    const value = JSON.stringify({ mode: "cobrand", partnerDisplayName: "LEAKED-NAME" });
    const { only } = await evaluate({ brandConfig: value });
    const transform = only("sst.aws.CognitoUserPool").args.transform as { userPool: unknown };
    const failure = await resolveDeep(transform.userPool).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toMatch(/^BrandConfig does not match ADR-0018/);
    expect(failure).not.toContain("LEAKED-NAME");
  });
});
