// The Leads table, LeadStream and the account deletion (ADR-0026, docs/architecture.md §1, §5 and §14)
// against their spec (infra/leads-spec.ts) and the module that builds them (infra/leads.ts, read as
// text: it only evaluates inside the SST program). The stream filters are run against sample records
// with a small matcher of Lambda's event filtering (literals, `prefix`, `exists`).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNT_ID, APP, APP_DOMAIN, CAPABILITIES, EMAIL_CONFIGURATION_SET, IAM_ARNS, LAMBDA_CAPABILITIES, REGION, STAGE, expectedGrants, type LambdaName } from "./iam-capabilities";
import {
  LEADS_PROTECTION,
  LEADS_STREAM,
  LEADS_TABLE_ACTIONS,
  LEAD_NOTIFY_RECIPIENTS,
  LEAD_NOTIFY_SENDER,
  LEAD_STREAM_CONSUMER,
  LEAD_STREAM_FILTERS,
  LEAD_SWEEP,
  SIGNUP_CAPABILITIES,
  SIGNUP_HANDLERS,
  guestAccountDeletionName,
  leadStreamDlqName,
} from "./leads-spec";
import { TABLE_ACTIONS } from "./storage-access";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const leadsModule = read("infra/leads.ts").replace(/^\s*\/\/.*$/gm, "");
const architecture = read("docs/architecture.md");

// ---- A matcher of Lambda event filtering, enough for the patterns of LEAD_STREAM_FILTERS ------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function matchesValue(rule: Json, value: Json | undefined): boolean {
  if (typeof rule === "object" && rule !== null && !Array.isArray(rule)) {
    if ("exists" in rule) return (value !== undefined) === rule.exists;
    if ("prefix" in rule) return typeof value === "string" && typeof rule.prefix === "string" && value.startsWith(rule.prefix);
  }
  return value !== undefined && rule === value;
}

function matches(pattern: Json, event: Json | undefined): boolean {
  if (Array.isArray(pattern)) return pattern.some((rule) => matchesValue(rule, event));
  if (typeof pattern !== "object" || pattern === null) return false;
  return Object.entries(pattern).every(([key, rule]) => {
    const inner = typeof event === "object" && event !== null && !Array.isArray(event) ? event[key] : undefined;
    // An `exists: false` on an absent parent still holds.
    if (inner === undefined && Array.isArray(rule)) return rule.some((item) => typeof item === "object" && item !== null && !Array.isArray(item) && item.exists === false);
    if (inner === undefined && !Array.isArray(rule)) return matches(rule, {});
    return matches(rule, inner);
  });
}

const filters = LEAD_STREAM_FILTERS as unknown as Json[];
const handled = (record: Json): boolean => filters.some((filter) => matches(filter, record));

const S = (value: string) => ({ S: value });
const META = { PK: S("LEAD#9f2c"), SK: S("META") };
const pending = { ...META, leadId: S("01J9ZX"), pendingUsernames: { L: [S("gst-01J9ZX")] } };
const confirmed = { ...pending, status: S("CONFIRMED"), confirmedAt: S("2026-10-01T10:00:00Z") };
const ttl = { type: "Service", principalId: "dynamodb.amazonaws.com" };

describe("LeadStream's filters (ADR-0026) [FL-116]", () => {
  it("takes a pending lead that becomes CONFIRMED, once", () => {
    expect(handled({ eventName: "MODIFY", dynamodb: { Keys: META, OldImage: pending, NewImage: confirmed } })).toBe(true);
    expect(handled({ eventName: "MODIFY", dynamodb: { Keys: META, OldImage: confirmed, NewImage: { ...confirmed, lastLoginAt: S("x") } } })).toBe(false);
    expect(handled({ eventName: "MODIFY", dynamodb: { Keys: META, OldImage: pending, NewImage: { ...pending, name: S("x") } } })).toBe(false);
    expect(handled({ eventName: "INSERT", dynamodb: { Keys: META, NewImage: pending } })).toBe(false);
  });

  it("takes a lead DynamoDB removed by TTL, never one deleted on request", () => {
    expect(handled({ eventName: "REMOVE", userIdentity: ttl, dynamodb: { Keys: META, OldImage: pending } })).toBe(true);
    expect(handled({ eventName: "REMOVE", userIdentity: ttl, dynamodb: { Keys: META, OldImage: confirmed } })).toBe(true);
    expect(handled({ eventName: "REMOVE", dynamodb: { Keys: META, OldImage: confirmed } })).toBe(false);
  });

  it("never takes an event of a lead or a line of the lead log", () => {
    for (const Keys of [{ PK: S("LEAD#9f2c"), SK: S("EVT#2026-10-01#01J9") }, { PK: S("LEADLOG#2026-10"), SK: S("2026-10-01#01J9") }]) {
      expect(handled({ eventName: "REMOVE", userIdentity: ttl, dynamodb: { Keys } })).toBe(false);
      expect(handled({ eventName: "MODIFY", dynamodb: { Keys, OldImage: {}, NewImage: { status: S("CONFIRMED") } } })).toBe(false);
    }
  });
});

describe("the Leads table (ADR-0026)", () => {
  it("keeps deletion protection on and point-in-time recovery off, with old and new images on its stream", () => {
    expect(LEADS_PROTECTION).toEqual({ deletionProtection: true, pointInTimeRecovery: false });
    expect(LEADS_STREAM).toBe("new-and-old-images");
    expect(leadsModule).toContain("deletionProtection: LEADS_PROTECTION.deletionProtection");
    expect(leadsModule).toContain("args.pointInTimeRecovery = { enabled: LEADS_PROTECTION.pointInTimeRecovery }");
    expect(leadsModule).toContain("stream: LEADS_STREAM");
    expect(architecture).toContain("`deletionProtectionEnabled`, sin PITR");
  });

  it("uses the table actions of infra/storage-access.ts for LEADS_READ and LEADS_WRITE, on the table and its GSI", () => {
    expect(LEADS_TABLE_ACTIONS.read).toEqual(TABLE_ACTIONS.read);
    expect(LEADS_TABLE_ACTIONS.write).toEqual(TABLE_ACTIONS.write);
    expect(SIGNUP_CAPABILITIES.LEADS_READ.grants).toEqual([{ actions: TABLE_ACTIONS.read, resources: ["{Leads}", "{Leads}/index/*"] }]);
    expect(SIGNUP_CAPABILITIES.LEADS_WRITE.grants).toEqual([{ actions: TABLE_ACTIONS.write, resources: ["{Leads}", "{Leads}/index/*"] }]);
  });

  it("is outside WORLDS and outside the QaDriver but for reads", () => {
    expect(JSON.stringify(CAPABILITIES.WORLDS)).not.toContain("Leads");
    const qa = expectedGrants("QaDriver").filter((grant) => grant.resources.some((resource) => resource.startsWith("{Leads}")));
    for (const grant of qa) for (const action of grant.actions) expect(TABLE_ACTIONS.read).toContain(action);
  });
});

describe("LeadStream and its dead letters", () => {
  it("splits a failed batch, retries three times and sends the rest to LeadStreamDlq, with no alarm (ADR-0028)", () => {
    expect(LEAD_STREAM_CONSUMER).toMatchObject({ maximumRetryAttempts: 3, bisectBatchOnFunctionError: true, startingPosition: "LATEST" });
    expect(leadsModule).toContain("destinationConfig: { onFailure: { destinationArn: leadStreamDlq.arn } }");
    expect(leadsModule).toContain("filterCriteria: { filters: LEAD_STREAM_FILTERS.map(");
    expect(leadStreamDlqName()).toBe(`${APP}-${STAGE}-LeadStreamDlq`);
    // Logs only (ADR-0028): an alarm with no action costs every month and nobody reads it (infra/logs-only.test.ts).
    expect(leadsModule).not.toMatch(/cloudwatch\.MetricAlarm|LeadStreamDlqAlarm/);
  });

  it("sweeps UNCONFIRMED users once a day", () => {
    expect(LEAD_SWEEP.event).toEqual({ kind: "UNCONFIRMED_SWEEP" });
    const [minute, hour, dayOfMonth, month, dayOfWeek] = /^cron\((.+)\)$/.exec(LEAD_SWEEP.schedule)?.[1]?.split(" ") ?? [];
    expect([minute, hour].every((field) => /^\d+$/.test(field ?? ""))).toBe(true);
    expect([dayOfMonth, month, dayOfWeek]).toEqual(["*", "*", "?"]);
    expect(leadsModule).toMatch(/new sst\.aws\.Cron\("LeadSweep", \{\s+function: leadStream\.arn,\s+schedule: LEAD_SWEEP\.schedule,/);
  });

  it("links the notice channel with SEND_LEAD_NOTIFY only: leads@ to *@craftech.io on the app's identity", () => {
    expect(LEAD_NOTIFY_SENDER).toBe(`leads@${APP_DOMAIN}`);
    expect(LEAD_NOTIFY_RECIPIENTS).toBe("*@craftech.io");
    const [grant] = SIGNUP_CAPABILITIES.SEND_LEAD_NOTIFY.grants;
    expect(grant?.resources).toEqual([IAM_ARNS.sesIdentity, IAM_ARNS.sesConfigurationSet]);
    expect(grant?.resources.join(" ")).toContain(`${REGION}:${ACCOUNT_ID}:configuration-set/${EMAIL_CONFIGURATION_SET}`);
    expect(leadsModule).toMatch(/new sst\.aws\.Function\("LeadStream"[\s\S]*?link: links\(\[Leads, LeadNotifyChannel, LeadConfig, guestAccountDeletion\], authLink\(\)\)/);
  });
});

describe("GuestAccountDeletion", () => {
  it("has the fixed name of docs/architecture.md §1, which the operator invokes", () => {
    expect(guestAccountDeletionName()).toBe(`${APP}-${STAGE}-guest-account-deletion`);
    expect(guestAccountDeletionName().length).toBeLessThanOrEqual(64);
    expect(architecture).toContain(`\`${guestAccountDeletionName()}\``);
    expect(leadsModule).toContain("name: guestAccountDeletionName($app.name, $app.stage)");
  });
});

describe("handlers of the flow", () => {
  it.each(Object.entries(SIGNUP_HANDLERS))("%s points at a module of packages/bff named in docs/build-plan.md", (name, handler) => {
    expect(handler).toMatch(/^packages\/bff\/src\/(auth-triggers|handlers)\/[a-z-]+\.handler$/);
    expect(read("docs/build-plan.md")).toContain(`\`${handler.replace(/\.handler$/, ".ts")}\``);
    expect(LAMBDA_CAPABILITIES[name as LambdaName]).toBeDefined();
  });
});
