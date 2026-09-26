// infra/messaging-email-spec.ts is plain data and is checked directly. infra/messaging-email.ts only
// evaluates inside the SST program ($app, sst, aws, $util, $interpolate), so the last block evaluates
// it against a recording fake of those globals: every resource it creates is kept with its arguments
// and every Output is a promise the test resolves. What is asserted is what the module hands to SES,
// Route 53, EventBridge and IAM, not its source text.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITIES, IAM_ARNS, SENDERS } from "./iam-capabilities";
import {
  CONFIGURATION_SET_NAME,
  DMARC_POLICY,
  EMAIL_LINK_NAME,
  EMAIL_DOMAIN,
  EMAIL_EVENT_TYPES,
  MAIL_FROM_DOMAIN,
  MAX_DEMO_RECIPIENTS,
  SENDER_ADDRESSES,
  UNPUBLISHED_EVENT_TYPES,
  assertDeclaredArns,
  defaultEventBusArn,
  demoRecipients,
  dkimTokens,
  emailDnsRecords,
  emailEventPattern,
  emailLinkProperties,
  feedbackMxHost,
  sendEmailGrant,
} from "./messaging-email-spec";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const ACCOUNT = "776805327629";
const TOKENS = ["a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6", "q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2", "g3h4i5j6k7l8m9n0o1p2q3r4s5t6u7v8"];
const SIMULATOR = "*@simulator.amazonses.com";
const overrides = (emails: string[]): string => JSON.stringify({ demoRecipients: { emails, phones: [] } });
const failureOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
};

describe("identity and DNS records (ADR-0003)", () => {
  it("sends from the app domain with MAIL FROM bounce. and the fixed configuration set of docs/architecture.md §1", () => {
    expect([EMAIL_DOMAIN, MAIL_FROM_DOMAIN, CONFIGURATION_SET_NAME]).toEqual([
      "cuadrilla.demo.craftech.io",
      "bounce.cuadrilla.demo.craftech.io",
      "aws-cds-hackathon-poc-cuadrilla-email-poc",
    ]);
    expect(SENDER_ADDRESSES).toEqual({ certificates: "actas@cuadrilla.demo.craftech.io", alerts: "avisos@cuadrilla.demo.craftech.io" });
    expect(Object.values(SENDER_ADDRESSES).sort()).toEqual([...SENDERS].sort());
    const architecture = read("docs/architecture.md");
    expect(architecture).toContain(`| Configuration set | \`${CONFIGURATION_SET_NAME}\` |`);
    expect(architecture).toContain(`MAIL FROM \`${MAIL_FROM_DOMAIN}\``);
  });

  it("writes three DKIM CNAMEs, SES's feedback MX and SPF -all on bounce., and DMARC p=reject", () => {
    expect(emailDnsRecords(TOKENS, "us-east-1")).toEqual([
      ...TOKENS.map((token) => ({ type: "CNAME", name: `${token}._domainkey.${EMAIL_DOMAIN}`, value: `${token}.dkim.amazonses.com` })),
      { type: "MX", name: MAIL_FROM_DOMAIN, value: "10 feedback-smtp.us-east-1.amazonses.com" },
      { type: "TXT", name: MAIL_FROM_DOMAIN, value: "v=spf1 include:amazonses.com -all" },
      { type: "TXT", name: `_dmarc.${EMAIL_DOMAIN}`, value: "v=DMARC1; p=reject; adkim=r; aspf=r" },
    ]);
    expect(read("docs/architecture.md")).toContain(`\`_dmarc.${EMAIL_DOMAIN}\` = \`${DMARC_POLICY}\``);
  });

  it("never publishes a receiving MX: the only MX is the feedback endpoint of bounce., and the domain itself has none", () => {
    const records = emailDnsRecords(TOKENS, "us-east-1");
    const mx = records.filter((record) => record.type === "MX");
    expect(mx).toHaveLength(1);
    expect(mx[0]?.name).toBe(MAIL_FROM_DOMAIN);
    expect(mx[0]?.value).not.toMatch(/inbound-smtp/);
    expect(records.some((record) => record.name === EMAIL_DOMAIN)).toBe(false);
  });

  it("keeps every record inside the app domain, the only names the CI role may change in the shared zone", () => {
    for (const record of emailDnsRecords(TOKENS, "us-east-1")) expect(record.name.endsWith(`.${EMAIL_DOMAIN}`), record.name).toBe(true);
    expect(read("infra/bootstrap/ci-role.yaml")).toContain('!Sub "*.${AppDomain}"');
  });

  it("accepts only the three DKIM labels of Easy DKIM and only a real region for the feedback MX", () => {
    expect(dkimTokens(TOKENS)).toEqual(TOKENS);
    expect(() => dkimTokens(TOKENS.slice(0, 2))).toThrow(/returned 2 DKIM tokens/);
    expect(() => dkimTokens(undefined)).toThrow(/returned 0/);
    expect(() => dkimTokens([...TOKENS.slice(0, 2), "evil.example.com"])).toThrow(/lowercase DNS label/);
    expect(() => feedbackMxHost("us-east-1.attacker.example")).toThrow(/not an AWS region/);
  });
});

describe("SES events to ChannelEvents [FL-048] [FL-051]", () => {
  it("publishes exactly the seven types of docs/architecture-integrations.md §2, never OPEN, CLICK or SUBSCRIPTION", () => {
    const line = read("docs/architecture-integrations.md")
      .split("\n")
      .find((text) => text.startsWith("Configuration set → EventBridge"));
    const documented = [...(line ?? "").split(";")[0]!.matchAll(/`([A-Z_]+)`/g)].map((match) => match[1]);
    expect([...EMAIL_EVENT_TYPES]).toEqual(documented);
    for (const type of UNPUBLISHED_EVENT_TYPES) expect(EMAIL_EVENT_TYPES as readonly string[]).not.toContain(type);
  });

  it("reads them from the default bus by the configuration set's own tag, so the other app's SES events never match", () => {
    expect(defaultEventBusArn("us-east-1", ACCOUNT)).toBe(`arn:aws:events:us-east-1:${ACCOUNT}:event-bus/default`);
    expect(() => defaultEventBusArn("us-east-1", "*")).toThrow(/12 digits/);
    expect(emailEventPattern()).toEqual({ source: ["aws.ses"], detail: { mail: { tags: { "ses:configuration-set": [CONFIGURATION_SET_NAME] } } } });
  });
});

describe("sending permission: SEND_EMAIL with the demo recipients [FL-076]", () => {
  const [declared] = CAPABILITIES.SEND_EMAIL.grants;

  it("is SEND_EMAIL of infra/iam-capabilities.ts verbatim while SeedOverrides has no demo recipients", () => {
    expect(demoRecipients("{}")).toEqual([]);
    expect(sendEmailGrant(demoRecipients("{}"))).toEqual(declared);
    expect(declared).toEqual({
      actions: ["ses:SendEmail"],
      resources: [IAM_ARNS.sesIdentity, IAM_ARNS.sesConfigurationSet],
      conditions: [
        { test: "StringEquals", variable: "ses:FromAddress", values: SENDERS },
        { test: "ForAllValues:StringLike", variable: "ses:Recipients", values: [SIMULATOR] },
      ],
    });
  });

  it("adds the registered demo recipients to ses:Recipients, sorted, without duplicates or simulator addresses", () => {
    const recipients = demoRecipients(overrides(["ops.demo@corp.mx", "chief+zona-norte@corp.mx", "ops.demo@corp.mx", "success+x@simulator.amazonses.com"]));
    expect(recipients).toEqual(["chief+zona-norte@corp.mx", "ops.demo@corp.mx"]);
    const grant = sendEmailGrant(recipients);
    expect(grant.conditions?.[1]).toEqual({ test: "ForAllValues:StringLike", variable: "ses:Recipients", values: [SIMULATOR, ...recipients] });
    expect(grant.conditions?.[0]).toEqual(declared?.conditions?.[0]);
    expect(grant.actions).toEqual(["ses:SendEmail"]);
  });

  it.each([
    ["an IAM wildcard", ["ab*@corp.mx"]],
    ["an uppercase address", ["Ops.Demo@corp.mx"]],
    ["the app's own domain", ["actas@cuadrilla.demo.craftech.io"]],
    ["a subdomain of the app domain", ["x@bounce.cuadrilla.demo.craftech.io"]],
    ["a reserved domain", ["ops@corp.test"]],
    ["example.com", ["ops@example.com"]],
  ])("fails the deploy on %s, naming the position and never the address", (_case, emails) => {
    const message = failureOf(() => demoRecipients(overrides(emails)));
    expect(message).toMatch(/SeedOverrides/);
    for (const email of emails) expect(message).not.toContain(email);
  });

  it("fails on a SeedOverrides that is not JSON or not its schema, and on more recipients than the policy takes", () => {
    expect(failureOf(() => demoRecipients("{not json"))).toBe("SeedOverrides is not valid JSON (value not shown).");
    expect(failureOf(() => demoRecipients(JSON.stringify({ secretField: "LEAKED" })))).not.toContain("LEAKED");
    const many = Array.from({ length: MAX_DEMO_RECIPIENTS + 1 }, (_, index) => `ops${index}@corp.mx`);
    expect(failureOf(() => demoRecipients(overrides(many)))).toMatch(/at most 20/);
  });

  it("fails the deploy when the identity or the configuration set is not the ARN SEND_EMAIL declares", () => {
    expect(() => assertDeclaredArns(IAM_ARNS.sesIdentity, IAM_ARNS.sesConfigurationSet)).not.toThrow();
    expect(() => assertDeclaredArns(IAM_ARNS.sesIdentity.replace(ACCOUNT, "111111111111"), IAM_ARNS.sesConfigurationSet)).toThrow(/ACCOUNT_ID/);
  });

  it("links the identity domain, the configuration set and the two senders under the name the SES client reads", () => {
    expect(emailLinkProperties()).toEqual({ identityDomain: EMAIL_DOMAIN, configurationSetName: CONFIGURATION_SET_NAME, senders: SENDER_ADDRESSES });
    expect(EMAIL_LINK_NAME).toBe("EmailChannel");
  });

  const SES_CLIENT_CONFIG = "packages/bff/src/channels/email/config.ts";
  it.skipIf(!existsSync(resolve(process.cwd(), SES_CLIENT_CONFIG)))("carries every field the SES client reads from the link", () => {
    const config = read(SES_CLIENT_CONFIG);
    expect(config).toContain(`readLinked("${EMAIL_LINK_NAME}"`);
    const start = config.search(/EmailChannelResource = z\s*\.object\(\{/);
    const keys = [...config.slice(start, config.indexOf("});", start)).matchAll(/^\s*(\w+)\s*:/gm)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(Object.keys(emailLinkProperties()), key).toContain(key);
  });
});

// ---- infra/messaging-email.ts on a recording SST runtime ----------------------------------------

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

async function resolveDeep(value: unknown): Promise<unknown> {
  if (value instanceof FakeOutput) return resolveDeep(await value.promise);
  if (Array.isArray(value)) return Promise.all(value.map(resolveDeep));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, inner]) => [key, await resolveDeep(inner)] as const)));
  }
  return value;
}

interface Created {
  readonly type: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

interface Scenario {
  readonly seedOverrides?: string;
  readonly account?: string;
  /** What infra/workers.ts exports; `channelEvents` by default. */
  readonly workers?: "channelEvents" | "nothing";
}

async function evaluate(scenario: Scenario = {}) {
  const created: Created[] = [];
  const record = (type: string, name: string, args: unknown) => created.push({ type, name, args: args as Record<string, unknown> });
  const recorded = (type: string) =>
    class {
      constructor(name: string, args: unknown) {
        record(type, name, args);
      }
    };
  const account = scenario.account ?? ACCOUNT;

  class FakeFunction {
    readonly arn = output(`arn:aws:lambda:us-east-1:${account}:function:ChannelEvents`);
  }
  class EmailIdentity {
    readonly emailIdentity: FakeOutput;
    readonly arn: FakeOutput;
    readonly dkimSigningAttributes = output({ tokens: TOKENS });
    constructor(name: string, args: { emailIdentity: string }) {
      record("aws.sesv2.EmailIdentity", name, args);
      this.emailIdentity = output(args.emailIdentity);
      this.arn = output(`arn:aws:ses:us-east-1:${account}:identity/${args.emailIdentity}`);
    }
  }
  class ConfigurationSet {
    readonly configurationSetName: FakeOutput;
    readonly arn: FakeOutput;
    constructor(name: string, args: { configurationSetName: string }) {
      record("aws.sesv2.ConfigurationSet", name, args);
      this.configurationSetName = output(args.configurationSetName);
      this.arn = output(`arn:aws:ses:us-east-1:${account}:configuration-set/${args.configurationSetName}`);
    }
  }

  vi.resetModules();
  vi.stubGlobal("$app", { name: "aws-cds-hackathon-poc-cuadrilla", stage: "poc" });
  vi.stubGlobal("sst", {
    Secret: class {
      constructor(readonly name: string) {}
      get value(): FakeOutput {
        return output(this.name === "SeedOverrides" ? (scenario.seedOverrides ?? "{}") : `value-of-${this.name}`);
      }
    },
    Linkable: recorded("sst.Linkable"),
    aws: {
      dns: (args: unknown) => ({
        provider: "aws",
        args,
        createRecord: (prefix: string, dnsRecord: unknown) => {
          record("dns.createRecord", prefix, dnsRecord);
          return output({});
        },
      }),
      permission: (input: object) => ({ type: "aws.permission", ...input }),
      Function: FakeFunction,
      Bus: {
        subscribe: (name: string, busArn: unknown, subscriber: unknown, args: unknown) => {
          record("sst.aws.Bus.subscribe", name, { busArn, subscriber, args });
          return output({});
        },
      },
    },
  });
  vi.stubGlobal("aws", {
    getRegionOutput: () => ({ region: output("us-east-1") }),
    getCallerIdentityOutput: () => ({ accountId: output(account) }),
    sesv2: {
      EmailIdentity,
      ConfigurationSet,
      EmailIdentityMailFromAttributes: recorded("aws.sesv2.EmailIdentityMailFromAttributes"),
      ConfigurationSetEventDestination: recorded("aws.sesv2.ConfigurationSetEventDestination"),
    },
  });
  vi.stubGlobal("$util", {
    output,
    all: (values: unknown[]) => new FakeOutput(Promise.all(values.map((value) => output(value).promise))),
    log: { warn: vi.fn() },
  });
  // vitest's module mock throws on a missing export, so "exports nothing" is an undefined binding.
  vi.doMock("./workers", () => ({ channelEvents: scenario.workers === "nothing" ? undefined : new FakeFunction() }));
  const module = await import("./messaging-email");
  const only = (type: string): Created => {
    const matching = created.filter((entry) => entry.type === type);
    expect(matching, type).toHaveLength(1);
    return matching[0] as Created;
  };
  return { module, created, only, EmailIdentity };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("./workers");
});

describe("infra/messaging-email.ts on a recording SST runtime", () => {
  it("creates the identity, MAIL FROM, configuration set, event destination, six records, the rule and the link, and nothing that receives", async () => {
    const { created } = await evaluate();
    expect(created.map((entry) => entry.type).sort()).toEqual(
      [
        "aws.sesv2.ConfigurationSet",
        "aws.sesv2.ConfigurationSetEventDestination",
        "aws.sesv2.EmailIdentity",
        "aws.sesv2.EmailIdentityMailFromAttributes",
        ...Array<string>(6).fill("dns.createRecord"),
        "sst.Linkable",
        "sst.aws.Bus.subscribe",
      ].sort(),
    );
    for (const entry of created) expect(`${entry.type} ${entry.name}`).not.toMatch(/Receipt|Bucket|Inbound/i);
    const source = read("infra/messaging-email.ts").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/Receipt|inbound-smtp|ses\.Domain|sst\.aws\.Email\b/);
  });

  it("builds the identity with 2048-bit Easy DKIM and no default configuration set, and MAIL FROM bounce. with fallback", async () => {
    const { only, module, EmailIdentity } = await evaluate();
    expect(only("aws.sesv2.EmailIdentity").args).toEqual({ emailIdentity: EMAIL_DOMAIN, dkimSigningAttributes: { nextSigningKeyLength: "RSA_2048_BIT" } });
    expect(await resolveDeep(only("aws.sesv2.EmailIdentityMailFromAttributes").args)).toEqual({
      emailIdentity: EMAIL_DOMAIN,
      mailFromDomain: MAIL_FROM_DOMAIN,
      behaviorOnMxFailure: "USE_DEFAULT_VALUE",
    });
    expect(only("aws.sesv2.ConfigurationSet").args).toEqual({ configurationSetName: CONFIGURATION_SET_NAME, reputationOptions: { reputationMetricsEnabled: true } });
    // The contract with infra/auth.ts: an aws.sesv2.EmailIdentity it reads live before moving Cognito onto it.
    expect(module.emailIdentity).toBeInstanceOf(EmailIdentity);
  });

  it("writes the records of the spec through the Route 53 adapter of infra/dns.ts", async () => {
    const { created } = await evaluate();
    const records = await Promise.all(created.filter((entry) => entry.type === "dns.createRecord").map((entry) => resolveDeep(entry.args)));
    expect(records).toEqual(emailDnsRecords(TOKENS, "us-east-1"));
    for (const entry of created.filter((item) => item.type === "dns.createRecord")) expect(entry.name).toBe("Email");
  });

  it("sends the seven types to the default bus and subscribes ChannelEvents there with the configuration set's tag", async () => {
    const { only } = await evaluate();
    expect(await resolveDeep(only("aws.sesv2.ConfigurationSetEventDestination").args)).toEqual({
      configurationSetName: CONFIGURATION_SET_NAME,
      eventDestinationName: "channel-events",
      eventDestination: { enabled: true, matchingEventTypes: [...EMAIL_EVENT_TYPES], eventBridgeDestination: { eventBusArn: defaultEventBusArn("us-east-1", ACCOUNT) } },
    });
    const subscription = only("sst.aws.Bus.subscribe");
    expect(subscription.name).toBe("EmailEvents");
    expect(await resolveDeep(subscription.args)).toEqual({
      busArn: defaultEventBusArn("us-east-1", ACCOUNT),
      subscriber: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:ChannelEvents`,
      args: { pattern: emailEventPattern() },
    });
  });

  it("fails the deploy when infra/workers.ts does not export channelEvents", async () => {
    const { only } = await evaluate({ workers: "nothing" });
    await expect(resolveDeep(only("sst.aws.Bus.subscribe").args)).rejects.toThrow(/infra\/workers\.ts does not export channelEvents/);
  });

  it("links what a sender reads and grants SEND_EMAIL with the demo recipients of SeedOverrides [FL-076]", async () => {
    const { only } = await evaluate({ seedOverrides: overrides(["ops.demo@corp.mx"]) });
    const link = only("sst.Linkable");
    expect(link.name).toBe(EMAIL_LINK_NAME);
    expect(link.args.properties).toEqual(emailLinkProperties());
    const include = (await resolveDeep(link.args.include)) as Array<Record<string, unknown>>;
    expect(include).toEqual([{ type: "aws.permission", ...sendEmailGrant(["ops.demo@corp.mx"]) }]);
    expect(include[0]?.actions).toEqual(["ses:SendEmail"]);
    expect(include[0]?.resources).toEqual([IAM_ARNS.sesIdentity, IAM_ARNS.sesConfigurationSet]);
  });

  it("fails the deploy when the resources land in another account than SEND_EMAIL declares", async () => {
    const { only } = await evaluate({ account: "111111111111" });
    await expect(resolveDeep(only("sst.Linkable").args.include)).rejects.toThrow(/ACCOUNT_ID in infra\/iam-capabilities\.ts/);
  });
});
