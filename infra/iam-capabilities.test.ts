import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  JUSTIFIED_WILDCARDS,
  LAMBDA_CAPABILITIES,
  QA_DRIVER_DLQ_ONLY_ACTIONS,
  SERVICE_ROLES,
  WORLDS_LEADING_KEYS,
  actionDrift,
  agentModelArns,
  expectedActions,
  expectedGrants,
  expectedTables,
  resolveCapabilities,
  whatsappPhoneArn,
  type CapabilityName,
  type Grant,
  type LambdaName,
  type RoleName,
} from "./iam-capabilities";
import { BFF_LEAD_ATTRIBUTES, SERVER_LEAD_ATTRIBUTES } from "./leads-spec";
import { OBJECT_ACTIONS, TABLE_ACTIONS, dataAccessGrants, dataActions } from "./storage-access";

const architecture = readFileSync(resolve(process.cwd(), "docs/architecture.md"), "utf8");

/** First cell of every row of the per-role table of docs/architecture.md §14 that names a Lambda. */
function documentedLambdas(): string[] {
  const section = architecture.slice(architecture.indexOf("## 14."), architecture.indexOf("## 15."));
  const names: string[] = [];
  for (const line of section.split("\n")) {
    const cell = /^\| `([A-Za-z]+)` \|/.exec(line)?.[1];
    // Role names are PascalCase; capabilities (ALL_CAPS) and access levels (lower case) are not roles.
    if (cell && /^[A-Z][a-z]/.test(cell)) names.push(cell);
  }
  return names;
}

const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];
const ROLES = [...LAMBDAS, ...(Object.keys(SERVICE_ROLES) as RoleName[])];
const everyGrant = (): Array<[RoleName, Grant]> => ROLES.flatMap((role) => expectedGrants(role).map((grant) => [role, grant] as [RoleName, Grant]));
const AWS_PHONE_ID = `phone-number-id-${"0123456789abcdef".repeat(2)}`;

describe("capabilities table", () => {
  it("has one entry per Lambda of docs/architecture.md §14 and nothing else", () => {
    const documented = documentedLambdas();
    expect(documented.length).toBeGreaterThan(20);
    expect([...LAMBDAS].sort()).toEqual([...documented].sort());
  });

  it("builds PIPELINE from both senders, the output guardrails and the timers", () => {
    expect(resolveCapabilities(["PIPELINE"])).toEqual(["PIPELINE", "SEND_EMAIL", "SEND_WHATSAPP", "TIMERS"]);
    expect(CAPABILITIES.PIPELINE.grants[0]).toEqual({ actions: ["bedrock:ApplyGuardrail"], resources: ["{G2}", "{G3}"] });
  });

  it("grants both actions a Function URL with AWS_IAM needs since October 2025", () => {
    for (const mock of ["MOCK_NETWORK", "MOCK_DISPATCH"] as const) {
      const grants = CAPABILITIES[mock].grants;
      expect(grants.flatMap((grant) => grant.actions).sort()).toEqual(["lambda:InvokeFunction", "lambda:InvokeFunctionUrl"]);
      const url = grants.find((grant) => grant.actions.includes("lambda:InvokeFunctionUrl"));
      expect(url?.conditions).toEqual([{ test: "StringEquals", variable: "lambda:FunctionUrlAuthType", values: ["AWS_IAM"] }]);
    }
  });

  it("keeps Leads out of WORLDS and of every capability but LEADS_READ and LEADS_WRITE (ADR-0026)", () => {
    const onLeads = (Object.keys(CAPABILITIES) as CapabilityName[]).filter((name) => CAPABILITIES[name].grants.some((grant) => grant.resources.some((resource) => resource.startsWith("{Leads}"))));
    expect(onLeads.sort()).toEqual(["LEADS_READ", "LEADS_WRITE"]);
    expect(resolveCapabilities(["WORLDS"])).not.toEqual(expect.arrayContaining(["LEADS_READ"]));
    for (const name of ["WORLDS", "TIMERS", "MEMORY_ADMIN"] as const) expect(JSON.stringify(CAPABILITIES[name])).not.toContain("Leads");
  });

  it("gives WORLDS the world tables, the mock tables, the timers and the memory purge", () => {
    expect(resolveCapabilities(["WORLDS"])).toEqual(["MEMORY_ADMIN", "TIMERS", "WORLDS"]);
    expect(Object.keys(CAPABILITIES.WORLDS.tables ?? {}).sort()).toEqual(["Dispatch", "Network", "Reference"]);
    expect(Object.keys(expectedTables("WorldJanitor")).sort()).toEqual(
      ["AuditLog", "Cases", "Conversations", "CuadrillaMetrics", "Dispatch", "Isps", "Network", "People", "Reference", "Runtime", "WorkOrders"].sort(),
    );
    expect(expectedTables("WorldJanitor").Reference).toBe("read");
  });
});

describe("forbidden permissions (ADR-0003, ADR-0002)", () => {
  it("never grants an SES receipt-rule action nor WABA event destinations or associations", () => {
    for (const [role, grant] of everyGrant()) {
      for (const action of grant.actions) {
        expect(action, role).not.toMatch(/^ses:.*ReceiptRule/);
        expect(action, role).not.toMatch(/^social-messaging:(PutWhatsAppBusinessAccountEventDestinations|Associate|Disassociate)/);
      }
    }
  });

  it("never names every phone number of the account, only {whatsappPhone}", () => {
    for (const [role, grant] of everyGrant()) {
      for (const resource of grant.resources) expect(resource, role).not.toContain("phone-number-id/*");
      if (grant.actions.some((action) => action.startsWith("social-messaging:"))) expect(grant.resources, role).toEqual(["{whatsappPhone}"]);
    }
  });

  it("puts Resource * only on the justified actions, each with its fencing condition", () => {
    for (const [role, grant] of everyGrant()) {
      if (!grant.resources.includes("*")) continue;
      expect(grant.resources, role).toEqual(["*"]);
      for (const action of grant.actions) {
        const fences = JUSTIFIED_WILDCARDS[action];
        expect(fences, `${role}: ${action} on *`).toBeDefined();
        const variables = (grant.conditions ?? []).map((condition) => condition.variable);
        for (const variable of fences ?? []) expect(variables, `${role}: ${action}`).toContain(variable);
      }
    }
    expect(Object.keys(JUSTIFIED_WILDCARDS).sort()).toEqual(["cloudwatch:PutMetricData", "transcribe:StartTranscriptionJob"]);
  });

  it("never grants a wildcard action", () => {
    for (const [role, grant] of everyGrant()) for (const action of grant.actions) expect(action, role).not.toContain("*");
  });
});

describe("TRANSCRIBE", () => {
  it("splits the start (Resource *, bucket and key fenced) from the reads and deletes by ARN", () => {
    const [start, jobs] = CAPABILITIES.TRANSCRIBE.grants;
    expect(start).toMatchObject({ actions: ["transcribe:StartTranscriptionJob"], resources: ["*"] });
    expect(start?.conditions).toEqual([
      { test: "StringEquals", variable: "transcribe:OutputBucketName", values: ["{Media.name}"] },
      { test: "StringLike", variable: "transcribe:OutputKey", values: ["transcripts/*"] },
    ]);
    expect(jobs).toMatchObject({ actions: ["transcribe:GetTranscriptionJob", "transcribe:DeleteTranscriptionJob"] });
    expect(jobs?.resources).toEqual(["arn:aws:transcribe:us-east-1:776805327629:transcription-job/cuadrilla-poc-*"]);
  });

  it("is held only by the worker, and no role of the app creates or changes the vocabulary", () => {
    expect(ROLES.filter((role) => expectedActions(role).includes("transcribe:StartTranscriptionJob"))).toEqual(["InstallerWorker"]);
    for (const [role, grant] of everyGrant()) for (const action of grant.actions) expect(action, role).not.toMatch(/Vocabulary/);
  });
});

describe("models (ADR-0028)", () => {
  const PROFILE = "arn:aws:bedrock:us-east-1:776805327629:application-inference-profile/ab12cd34ef56";

  it("names the app's profile, the global profile and its foundation model region-less and in every region", () => {
    expect(agentModelArns("global.anthropic.claude-sonnet-5-5", "us-east-1", "776805327629", PROFILE)).toEqual([
      PROFILE,
      "arn:aws:bedrock:us-east-1:776805327629:inference-profile/global.anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5",
    ]);
    expect(agentModelArns("global.anthropic.claude-opus-5")).toEqual([
      "arn:aws:bedrock:us-east-1:776805327629:inference-profile/global.anthropic.claude-opus-5",
      "arn:aws:bedrock:::foundation-model/anthropic.claude-opus-5",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-5",
    ]);
    for (const arn of agentModelArns("global.anthropic.claude-sonnet-5-5", "us-east-1", "776805327629", PROFILE)) expect(arn).not.toMatch(/(model|profile)\/\*$|^\*$/);
  });

  it("lets ToolEvidence call its photo model, read the app's profile and nothing else of Bedrock runtime", () => {
    const grants = expectedGrants("ToolEvidence").filter((grant) => grant.actions.some((action) => action.startsWith("bedrock:")));
    expect(grants).toEqual([
      { actions: ["bedrock:InvokeModel"], resources: ["{model:PHOTO}"] },
      { sid: "ModelProfileRead", actions: ["bedrock:GetInferenceProfile"], resources: ["{model:PROFILE}"] },
      { actions: ["bedrock:ApplyGuardrail"], resources: ["{G2}", "{G3}"] },
    ]);
  });

  it("gives the Memory execution role only the extraction model (sid ExtractionModel) and the read of the app's profile", () => {
    expect(SERVICE_ROLES.Memory.grants).toEqual([
      { sid: "ExtractionModel", actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], resources: ["{model:HARNESS}"] },
      { sid: "ModelProfileRead", actions: ["bedrock:GetInferenceProfile"], resources: ["{model:PROFILE}"] },
    ]);
  });

  it("reads the app's profile exactly in the roles that call through it: the Harness, Memory and ToolEvidence", () => {
    const readers = ROLES.filter((role) => expectedGrants(role).some((grant) => grant.actions.includes("bedrock:GetInferenceProfile")));
    expect(readers.sort()).toEqual(["Harness", "Memory", "ToolEvidence"]);
    for (const role of readers) for (const grant of expectedGrants(role).filter((entry) => entry.actions.includes("bedrock:GetInferenceProfile"))) expect(grant.resources, role).toEqual(["{model:PROFILE}"]);
    expect(ROLES.filter((role) => expectedActions(role).some((action) => /^bedrock:(Create|Delete)InferenceProfile$/.test(action)))).toEqual([]);
  });
});

describe("whatsappPhoneArn", () => {
  it("builds the ARN from the AWS id without its prefix", () => {
    expect(whatsappPhoneArn(AWS_PHONE_ID)).toBe(`arn:aws:social-messaging:us-east-1:776805327629:phone-number-id/${"0123456789abcdef".repeat(2)}`);
  });

  it("omits the statement while the number is not connected and rejects the Meta id", () => {
    expect(whatsappPhoneArn("not-connected")).toBeUndefined();
    expect(() => whatsappPhoneArn("106540352242922")).toThrow(/AWS id/);
    expect(() => whatsappPhoneArn("*")).toThrow();
  });
});

describe("WORLDS fences per role", () => {
  it("limits Network and Dispatch by leading keys for every role that holds WORLDS", () => {
    const holders = LAMBDAS.filter((fn) => resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities).includes("WORLDS"));
    expect(holders.sort()).toEqual(Object.keys(WORLDS_LEADING_KEYS).sort());
  });

  it("keeps the QA driver on QA, evaluation and the test guest, and the others off them", () => {
    for (const key of WORLDS_LEADING_KEYS.QaDriver) expect(key).toMatch(/qa-|eval-|isp-guest-test#/);
    for (const key of [...WORLDS_LEADING_KEYS.Bff, ...WORLDS_LEADING_KEYS.WorldJanitor]) expect(key).not.toMatch(/qa-|eval-/);
    for (const key of WORLDS_LEADING_KEYS.WorldJanitor) expect(key).toContain("isp-guest-");
  });
});

describe("QaDriver", () => {
  it("reads and deletes only from the DLQ and reads only the DLQ alarm history", () => {
    const grants = expectedGrants("QaDriver");
    const dlq = grants.find((grant) => grant.actions.includes("sqs:ReceiveMessage"));
    expect(dlq).toEqual({ actions: [...QA_DRIVER_DLQ_ONLY_ACTIONS], resources: ["{InstallerEventsDlq}"] });
    for (const fn of ROLES.filter((name) => name !== "QaDriver")) {
      for (const action of ["cloudwatch:DescribeAlarmHistory", "sns:Publish"]) expect(expectedActions(fn), fn).not.toContain(action);
      expect(expectedGrants(fn).filter((grant) => grant.resources.includes("{InstallerEventsDlq}")), fn).toEqual([]);
      // Only the worker's event source mapping receives, and only from InstallerEvents.
      const receives = expectedGrants(fn).filter((grant) => QA_DRIVER_DLQ_ONLY_ACTIONS.some((action) => grant.actions.includes(action)));
      expect(receives.flatMap((grant) => grant.resources), fn).toEqual(fn === "InstallerWorker" ? ["{InstallerEvents}"] : []);
    }
  });

  it("publishes only on the app's own WhatsApp topic and writes only the kill switch of QA worlds", () => {
    const grants = expectedGrants("QaDriver");
    expect(grants.find((grant) => grant.actions.includes("sns:Publish"))?.resources).toEqual(["arn:aws:sns:us-east-1:776805327629:aws-cds-hackathon-poc-cuadrilla-wa-inbound"]);
    const runtime = grants.filter((grant) => grant.actions.includes("dynamodb:PutItem") && grant.resources.includes("{Runtime}"));
    expect(runtime).toHaveLength(1);
    expect(runtime[0]?.conditions?.[0]?.values.filter((key) => key.startsWith("KILL#"))).toEqual(["KILL#AGENT#qa-*"]);
  });

  it("holds the QA seam of ADR-0025 §7 on the stage's pool, the leads read and the two web ACLs, never AdminDeleteUser", () => {
    const grants = expectedGrants("QaDriver");
    const on = (resource: string) => grants.filter((grant) => grant.resources.includes(resource)).flatMap((grant) => grant.actions);
    expect(on("{UserPool}").sort()).toEqual(["cognito-idp:AdminConfirmSignUp", "cognito-idp:AdminGetUser", "cognito-idp:AdminInitiateAuth", "cognito-idp:GetWebACLForResource"]);
    expect(on("{EdgeWebAcl}")).toEqual(["wafv2:GetWebACL"]);
    expect(on("{AuthWebAcl}")).toEqual(["wafv2:GetWebACL"]);
    expect(on("arn:aws:wafv2:us-east-1:776805327629:regional/webacl/*/*")).toEqual(["wafv2:GetWebACLForResource"]);
    expect(resolveCapabilities(LAMBDA_CAPABILITIES.QaDriver.capabilities)).toContain("LEADS_READ");
    expect(resolveCapabilities(LAMBDA_CAPABILITIES.QaDriver.capabilities)).not.toContain("LEADS_WRITE");
  });
});

describe("least privilege", () => {
  it("keeps SES, End User Messaging and Bedrock away from the console BFF", () => {
    expect(expectedActions("Bff").some((action) => /^(ses|social-messaging|bedrock):/.test(action))).toBe(false);
  });

  it("lets only the worker invoke the Harness and gives no role a fenced write of a global kill switch (the operator turns them on, P-07)", () => {
    expect(ROLES.filter((role) => expectedActions(role).includes("bedrock-agentcore:InvokeHarness"))).toEqual(["InstallerWorker"]);
    const killWrite = (grant: Grant) => grant.actions.some((action) => /^dynamodb:(Put|Update|Delete|BatchWrite)Item$/.test(action)) && (grant.conditions ?? []).some((condition) => condition.values.some((value) => /^KILL#(?!AGENT#)/.test(value)));
    expect(ROLES.filter((role) => expectedGrants(role).some((grant) => grant.resources.includes("{Runtime}") && killWrite(grant)))).toEqual([]);
  });

  it("[W2-B2] gives a BUTTON_ACTION's needs to the worker that runs it, never to InboundWhatsApp: MOCK_NETWORK, CertificateWriter", () => {
    const has = (role: RoleName, action: string, resource: string) => expectedGrants(role).some((grant) => grant.actions.includes(action) && grant.resources.includes(resource));
    const needs = [["lambda:InvokeFunctionUrl", "{NetworkMock}"], ["lambda:InvokeFunction", "{CertificateWriter}"]] as const;
    for (const [action, resource] of needs) {
      expect(has("InstallerWorker", action, resource), `${action} on InstallerWorker`).toBe(true);
      expect(has("InboundWhatsApp", action, resource), `${action} on InboundWhatsApp`).toBe(false);
    }
  });

  it("reports drift between generated and declared actions", () => {
    expect(actionDrift("DispatchMock", ["events:PutEvents"])).toEqual({ extra: [], missing: [] });
    expect(actionDrift("DispatchMock", ["events:PutEvents", "ses:SendEmail"])).toEqual({ extra: ["ses:SendEmail"], missing: [] });
    expect(actionDrift("ScheduleDispatch", [])).toEqual({ extra: [], missing: expectedActions("ScheduleDispatch") });
  });
});

describe("data access [SEC-W1-01]", () => {
  const ITEM_ACTIONS = new Set(TABLE_ACTIONS.write);
  const OBJECT_ONLY = new Set(OBJECT_ACTIONS.write);
  const storageGrants = (fn: LambdaName) => dataAccessGrants(fn).storage;
  const grantOn = (fn: LambdaName, resource: string) => [...storageGrants(fn), ...dataAccessGrants(fn).mocks].find((grant) => grant.resources.includes(resource));

  it.each(LAMBDAS)("gives %s item and object actions only, never dynamodb:* or s3:* nor a table or bucket action", (fn) => {
    for (const action of dataActions(fn)) {
      expect(action, fn).not.toContain("*");
      expect(ITEM_ACTIONS.has(action) || OBJECT_ONLY.has(action), `${fn}: ${action}`).toBe(true);
    }
    for (const grant of [...storageGrants(fn), ...dataAccessGrants(fn).mocks]) {
      for (const resource of grant.resources) expect(resource, fn).toMatch(/^\{[A-Za-z]+\}(\/index\/\*|\/\*)?$/);
      if (grant.actions.some((action) => action.startsWith("s3:"))) for (const resource of grant.resources) expect(resource, `${fn}: objects only`).toMatch(/\/\*$/);
    }
  });

  it.each(LAMBDAS)("gives %s exactly the actions of the access it declares on each table and bucket", (fn) => {
    const tables = expectedTables(fn);
    for (const [table, access] of Object.entries(tables)) {
      expect(grantOn(fn, `{${table}}`)?.actions, `${fn}: ${table}`).toEqual(TABLE_ACTIONS[access]);
      if (access !== "append") expect(grantOn(fn, `{${table}}/index/*`)?.actions, `${fn}: ${table} GSIs`).toEqual(TABLE_ACTIONS[access]);
    }
    const linked = [...storageGrants(fn), ...dataAccessGrants(fn).mocks].flatMap((grant) => grant.resources.filter((resource) => !resource.includes("/")));
    expect(linked.map((resource) => resource.slice(1, -1)).sort()).toEqual(Object.keys(tables).sort());
  });

  it("keeps read-only roles read-only: no DeleteTable, UpdateItem, PutObject or bucket policy where the capability says read", () => {
    expect(grantOn("CertificateWriter", "{People}")?.actions).toEqual(TABLE_ACTIONS.read);
    expect(grantOn("CertificateWriter", "{Isps}")?.actions).toEqual(TABLE_ACTIONS.read);
    expect(grantOn("ToolEvidence", "{Media}/*")?.actions).toEqual(["s3:GetObject"]);
    expect(grantOn("Bff", "{Evidence}/*")?.actions).toEqual(["s3:GetObject"]);
    expect(TABLE_ACTIONS.read).toEqual(["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"]);
    for (const fn of LAMBDAS) for (const action of dataActions(fn)) expect(action).not.toMatch(/Table|Bucket|PublicAccessBlock|Cors/);
  });

  it("[SEC-W1-02] declares the pre token trigger: Query on Isps and its GSIs, PutItem on AuditLog, nothing else", () => {
    expect(LAMBDA_CAPABILITIES.AuthPreToken).toEqual({ capabilities: [], tables: { Isps: "read", AuditLog: "append" } });
    expect(expectedGrants("AuthPreToken")).toEqual([]);
    expect(dataAccessGrants("AuthPreToken")).toEqual({
      storage: [
        { actions: TABLE_ACTIONS.read, resources: ["{Isps}", "{Isps}/index/*"] },
        { actions: ["dynamodb:PutItem"], resources: ["{AuditLog}"] },
      ],
      mocks: [],
    });
  });

  it("fences the mocks' tables by leading keys for the WORLDS roles and not for the mocks themselves", () => {
    for (const role of Object.keys(WORLDS_LEADING_KEYS) as Array<keyof typeof WORLDS_LEADING_KEYS>) {
      const [mocks] = dataAccessGrants(role).mocks;
      expect(mocks?.resources).toEqual(["{Dispatch}", "{Dispatch}/index/*", "{Network}", "{Network}/index/*"]);
      expect(mocks?.conditions).toEqual([{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: WORLDS_LEADING_KEYS[role] }]);
    }
    expect(dataAccessGrants("NetworkMock").mocks).toEqual([{ actions: TABLE_ACTIONS.write, resources: ["{Network}", "{Network}/index/*"] }]);
  });
});

// ---- Own sign-up, guest worlds and leads (ADR-0025, ADR-0026, docs/test-plan.md §3) ----------------------

describe("sign-up and leads", () => {
  const grantsOn = (role: RoleName, resource: string) => expectedGrants(role).filter((grant) => grant.resources.includes(resource));
  const keysOf = (grant: Grant | undefined) => grant?.conditions?.find((condition) => condition.variable === "dynamodb:LeadingKeys")?.values;
  const cognito = (role: RoleName) => expectedActions(role).filter((action) => action.startsWith("cognito-idp:"));

  it("fences SEND_LEAD_NOTIFY to leads@ as sender and *@craftech.io as recipients, on the app's identity only", () => {
    expect(CAPABILITIES.SEND_LEAD_NOTIFY.grants).toEqual([
      {
        actions: ["ses:SendEmail"],
        resources: ["arn:aws:ses:us-east-1:776805327629:identity/cuadrilla.demo.craftech.io", "arn:aws:ses:us-east-1:776805327629:configuration-set/aws-cds-hackathon-poc-cuadrilla-email-poc"],
        conditions: [
          { test: "StringEquals", variable: "ses:FromAddress", values: ["leads@cuadrilla.demo.craftech.io"] },
          { test: "ForAllValues:StringLike", variable: "ses:Recipients", values: ["*@craftech.io"] },
        ],
      },
    ]);
    expect(ROLES.filter((role) => resolveCapabilities(roleCapabilities(role)).includes("SEND_LEAD_NOTIFY"))).toEqual(["LeadStream"]);
    // The demo's fence never admits craftech.io (CP-RECIPIENT-FENCE is unchanged).
    const demoRecipients = CAPABILITIES.SEND_EMAIL.grants.flatMap((grant) => grant.conditions ?? []).filter((condition) => condition.variable === "ses:Recipients");
    expect(demoRecipients.flatMap((condition) => condition.values)).toEqual(["*@simulator.amazonses.com"]);
  });

  it("lets the Bff write a lead only by LEAD#* and the form's attributes, never a server attribute", () => {
    const [grant] = grantsOn("Bff", "{Leads}");
    expect(grant?.actions).toEqual(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]);
    expect(keysOf(grant)).toEqual(["LEAD#*"]);
    const attributes = grant?.conditions?.find((condition) => condition.variable === "dynamodb:Attributes");
    expect(attributes).toEqual({ test: "ForAllValues:StringEquals", variable: "dynamodb:Attributes", values: [...BFF_LEAD_ATTRIBUTES] });
    for (const attribute of ["status", "cognitoSub", "cognitoUsername", "userId", "notifiedAt", "notifyOutcome"]) expect(attributes?.values).not.toContain(attribute);
    for (const attribute of SERVER_LEAD_ATTRIBUTES) expect(BFF_LEAD_ATTRIBUTES as readonly string[]).not.toContain(attribute);
    expect(grant?.conditions).toContainEqual({ test: "StringEqualsIfExists", variable: "dynamodb:ReturnValues", values: ["NONE", "UPDATED_OLD", "UPDATED_NEW"] });
    expect(grantsOn("Bff", "{Leads}/index/*")).toEqual([]);
  });

  it("fences each trigger's Runtime keys and reads, and gives the triggers no Cognito action", () => {
    const runtime = (role: RoleName) => grantsOn(role, "{Runtime}").map((grant) => ({ actions: [...grant.actions].sort(), keys: keysOf(grant) }));
    expect(runtime("AuthPreSignUp")).toEqual([
      { actions: ["dynamodb:UpdateItem"], keys: ["SIGNUPTICKET#*"] },
      { actions: ["dynamodb:BatchGetItem", "dynamodb:GetItem"], keys: ["SIGNUP#*", "SIGNUPKEY#*", "KILL#*"] },
    ]);
    expect(runtime("AuthCustomMessage")).toEqual([{ actions: ["dynamodb:BatchGetItem", "dynamodb:GetItem"], keys: ["KILL#*"] }]);
    expect(expectedGrants("AuthCustomMessage")).toHaveLength(1);
    expect(runtime("AuthPostConfirmation").map((grant) => grant.keys)).toEqual([["GUESTACCOUNT#*", "GUESTWORLDS#*", "SIGNUPOK#*", "SIGNUPKEY#*", "SIGNUPSUB#*"]]);
    // The sign-in finishes a confirmation that failed after Cognito confirmed the user (ADR-0025 §1).
    expect(runtime("AuthPostAuthentication").map((grant) => grant.keys)).toEqual([["GUESTACCOUNT#*", "GUESTWORLDS#*", "SIGNUPOK#*", "SIGNUPKEY#*", "SIGNUPSUB#*"]]);
    for (const role of ["AuthPostConfirmation", "AuthPostAuthentication"] as const) expect(keysOf(grantsOn(role, "{Isps}")[0])).toEqual(["ISP#isp-guest-s*"]);
    for (const role of ["AuthPreSignUp", "AuthCustomMessage", "AuthPostConfirmation", "AuthPostAuthentication", "AuthPreToken"] as const) expect(cognito(role), role).toEqual([]);
    for (const role of ["AuthPreSignUp", "AuthCustomMessage", "AuthPostConfirmation", "AuthPostAuthentication"] as const) expect(expectedTables(role), role).toEqual({});
  });

  it("deletes accounts without listing users, lets LeadStream list and delete, and keeps AdminDeleteUser from the QaDriver", () => {
    expect(cognito("GuestAccountDeletion")).toEqual(["cognito-idp:AdminDeleteUser", "cognito-idp:AdminGetUser"]);
    expect(cognito("LeadStream")).toEqual(["cognito-idp:AdminDeleteUser", "cognito-idp:ListUsers"]);
    expect(cognito("QaDriver")).not.toContain("cognito-idp:AdminDeleteUser");
    expect(ROLES.filter((role) => expectedActions(role).includes("cognito-idp:ListUsers"))).toEqual(["LeadStream"]);
    for (const role of ["GuestAccountDeletion", "LeadStream"] as const) for (const grant of expectedGrants(role).filter((item) => item.actions.some((action) => action.startsWith("cognito-idp:")))) expect(grant.resources).toEqual(["{UserPool}"]);
    expect(grantsOn("LeadStream", "{GuestAccountDeletion}")[0]?.actions).toEqual(["lambda:InvokeFunction"]);
    expect(expectedGrants("GuestAccountDeletion").find((grant) => grant.actions.includes("s3:ListBucket"))?.conditions).toEqual([{ test: "StringLike", variable: "s3:prefix", values: ["guest/*"] }]);
  });

  it("lets only the Bff, LeadStream and the QaDriver invoke the deletion, and only the triggers, the Bff and the QaDriver the world factory", () => {
    const invokers = (target: string) => ROLES.filter((role) => grantsOn(role, target).some((grant) => grant.actions.includes("lambda:InvokeFunction"))).sort();
    expect(invokers("{GuestAccountDeletion}")).toEqual(["Bff", "LeadStream", "QaDriver"]);
    expect(invokers("{GuestWorlds}")).toEqual(["AuthPostAuthentication", "AuthPostConfirmation", "Bff", "QaDriver"]);
  });

  it("fences the world factory and the deletion to guest worlds in the mocks' tables", () => {
    for (const role of ["GuestWorlds", "GuestAccountDeletion"] as const) expect(WORLDS_LEADING_KEYS[role]).toEqual(["ONU#GUEST#isp-guest-*", "DWO#isp-guest-*"]);
    expect(resolveCapabilities(LAMBDA_CAPABILITIES.GuestAccountDeletion.capabilities)).toContain("LEADS_WRITE");
    expect(resolveCapabilities(LAMBDA_CAPABILITIES.GuestWorlds.capabilities)).not.toContain("LEADS_WRITE");
  });
});

function roleCapabilities(role: RoleName): readonly CapabilityName[] {
  return role in LAMBDA_CAPABILITIES ? LAMBDA_CAPABILITIES[role as LambdaName].capabilities : SERVICE_ROLES[role as keyof typeof SERVICE_ROLES].capabilities;
}
