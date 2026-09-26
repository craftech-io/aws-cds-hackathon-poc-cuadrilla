// The measurement of the authentication emails (ADR-0025 §4, docs/architecture.md §12): the pool sends
// through the app's configuration set, whose CloudWatch destination takes `kind` from the message tag
// with `AUTH` by default, and the cut of the sign-up watches `Send`, `Bounce` and `Complaint` of that
// kind. The recording runtime of infra/messaging-email-spec.test.ts checks the destination as created;
// this file checks the contract between the pieces without an AWS account.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_TAG_NAMES } from "../packages/bff/src/channels/email/tags";
import { emailSenderFor } from "./auth-email";
import { AUTH_EMAIL_METRICS, AUTH_METRICS_DESTINATION_NAME, CONFIGURATION_SET_NAME, EMAIL_EVENT_TYPES, KIND_DIMENSION, METRIC_EVENT_TYPES, emailEventPattern } from "./messaging-email-spec";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const code = (path: string): string => read(path).replace(/^\s*\/\/.*$/gm, "");
const architecture = read("docs/architecture.md");
const APP_DOMAIN = "cuadrilla.demo.craftech.io";
const IDENTITY = { domain: APP_DOMAIN, arn: `arn:aws:ses:us-east-1:776805327629:identity/${APP_DOMAIN}`, verified: true };

describe("CloudWatch destination of the configuration set [FL-112]", () => {
  it("takes kind from the message tag, AUTH when the message has none", () => {
    expect(KIND_DIMENSION).toEqual({ dimensionName: "kind", dimensionValueSource: "MESSAGE_TAG", defaultDimensionValue: "AUTH" });
    expect(AUTH_METRICS_DESTINATION_NAME).toBe("auth-metrics");
    expect([...METRIC_EVENT_TYPES]).toEqual(["SEND", "BOUNCE", "COMPLAINT"]);
    for (const type of METRIC_EVENT_TYPES) expect(EMAIL_EVENT_TYPES as readonly string[]).toContain(type);
  });

  it("names the three metrics of §12 over AWS/SES with kind = AUTH", () => {
    expect(AUTH_EMAIL_METRICS).toEqual({
      AuthEmailSends: { namespace: "AWS/SES", metricName: "Send", dimensions: { kind: "AUTH" } },
      AuthEmailBounces: { namespace: "AWS/SES", metricName: "Bounce", dimensions: { kind: "AUTH" } },
      AuthEmailComplaints: { namespace: "AWS/SES", metricName: "Complaint", dimensions: { kind: "AUTH" } },
    });
    for (const name of Object.keys(AUTH_EMAIL_METRICS)) expect(architecture, name).toContain(`\`${name}\``);
  });

  it("counts only Cognito's emails as AUTH: every product email tags its kind", () => {
    expect(EMAIL_TAG_NAMES).toContain("kind");
    expect(code("packages/bff/src/channels/email/request.ts")).toMatch(/emailTags\(\{[^}]*\bkind: request\.kind/);
  });

  it("creates the destination in infra/messaging-email.ts from these values", () => {
    const source = code("infra/messaging-email.ts");
    expect(source).toContain("eventDestinationName: AUTH_METRICS_DESTINATION_NAME");
    expect(source).toContain("matchingEventTypes: [...METRIC_EVENT_TYPES]");
    expect(source).toContain("cloudWatchDestination: { dimensionConfigurations: [{ ...KIND_DIMENSION }] }");
  });
});

describe("the pool sends through the configuration set", () => {
  it("names the app's configuration set once Cognito sends with SES (DEVELOPER)", () => {
    const { configuration } = emailSenderFor(IDENTITY, APP_DOMAIN);
    expect(configuration).toMatchObject({ emailSendingAccount: "DEVELOPER", configurationSet: CONFIGURATION_SET_NAME });
    expect(CONFIGURATION_SET_NAME).toBe("aws-cds-hackathon-poc-cuadrilla-email-poc");
  });

  it("keeps Cognito's default sender, which takes no configuration set, until the identity is verified", () => {
    expect(emailSenderFor({ ...IDENTITY, verified: false }, APP_DOMAIN).configuration).toEqual({ emailSendingAccount: "COGNITO_DEFAULT" });
    expect(emailSenderFor(undefined, APP_DOMAIN).configuration).toEqual({ emailSendingAccount: "COGNITO_DEFAULT" });
  });

  it("keeps Cognito's emails, and the visitor's address, away from ChannelEvents", () => {
    const tags = emailEventPattern().detail.mail.tags;
    expect(tags.mailId).toEqual([{ exists: true }]);
    expect(EMAIL_TAG_NAMES).toContain("mailId");
  });
});

describe("the cut of the sign-up watches these metrics [FL-112]", () => {
  const source = code("infra/cost-guard.ts");
  const alarm = (suffix: string): string => {
    const start = source.indexOf(`name: alarmName("${suffix}")`);
    expect(start, suffix).toBeGreaterThan(0);
    return source.slice(source.lastIndexOf("new aws.cloudwatch.MetricAlarm", start), source.indexOf("}),", start));
  };

  it("bounces ≥ 5 in one hour", () => {
    const text = alarm("AuthEmailBounces");
    expect(text).toContain('sesMetric("AuthEmailBounces", 3600)');
    expect(text).toMatch(/threshold: 5,\s+comparisonOperator: "GreaterThanOrEqualToThreshold"/);
  });

  it("a bounce rate ≥ 3 % in 24 hours with at least 20 sends", () => {
    const text = alarm("AuthEmailBounceRate");
    expect(text).toContain('sesQuery("AuthEmailBounces", 86400)');
    expect(text).toContain('sesQuery("AuthEmailSends", 86400)');
    expect(text).toContain('expression: "IF(sends >= 20, bounces / sends, 0)"');
    expect(text).toMatch(/threshold: 0\.03,\s+comparisonOperator: "GreaterThanOrEqualToThreshold"/);
  });

  it("complaints ≥ 2 in 24 hours", () => {
    const text = alarm("AuthEmailComplaints");
    expect(text).toContain('sesMetric("AuthEmailComplaints", 86400)');
    expect(text).toMatch(/threshold: 2,\s+comparisonOperator: "GreaterThanOrEqualToThreshold"/);
  });

  it("more than 150 sign-ups started in one hour, from the Bff's log lines", () => {
    const text = alarm("SignupBurst");
    expect(text).toMatch(/metricName: SIGNUP_STARTED_METRIC,\s+statistic: "Sum",\s+period: 3600,\s+threshold: 150,\s+comparisonOperator: "GreaterThanThreshold"/);
    expect(source).toContain('pattern: `{ $.metric = "${SIGNUP_STARTED_METRIC}" }`');
  });

  it("publishes every alarm on CostAlerts and nothing else", () => {
    expect(source).toContain("const common = { alarmActions: [costAlerts.arn],");
    expect((source.match(/new aws\.cloudwatch\.MetricAlarm\(/g) ?? []).length).toBe(4);
    expect((source.match(/\.\.\.common,/g) ?? []).length).toBe(4);
  });
});
