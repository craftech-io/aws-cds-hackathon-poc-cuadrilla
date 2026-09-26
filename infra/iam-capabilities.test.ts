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
  type Grant,
  type LambdaName,
  type RoleName,
} from "./iam-capabilities";

const architecture = readFileSync(resolve(process.cwd(), "docs/architecture.md"), "utf8");

/** First cell of every row of the per-role table of docs/architecture.md §14 that names a Lambda. */
function documentedLambdas(): string[] {
  const section = architecture.slice(architecture.indexOf("## 14."), architecture.indexOf("## 15."));
  const names: string[] = [];
  for (const line of section.split("\n")) {
    const cell = /^\| `([A-Za-z]+)` \|/.exec(line)?.[1];
    if (cell && !/^[A-Z_]+$/.test(cell)) names.push(cell);
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
    expect(documented.length).toBeGreaterThan(15);
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

  it("gives WORLDS the world tables, the mock tables, the timers and the memory purge", () => {
    expect(resolveCapabilities(["WORLDS"])).toEqual(["MEMORY_ADMIN", "TIMERS", "WORLDS"]);
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

describe("models", () => {
  it("names the global inference profile and its foundation model region-less and in every region", () => {
    expect(agentModelArns("global.anthropic.claude-opus-5", "us-east-1", "776805327629")).toEqual([
      "arn:aws:bedrock:us-east-1:776805327629:inference-profile/global.anthropic.claude-opus-5",
      "arn:aws:bedrock:::foundation-model/anthropic.claude-opus-5",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-5",
    ]);
    for (const arn of agentModelArns("global.anthropic.claude-opus-5")) expect(arn).not.toMatch(/foundation-model\/\*$/);
  });

  it("lets ToolEvidence call its photo model and nothing else of Bedrock runtime", () => {
    const grants = expectedGrants("ToolEvidence").filter((grant) => grant.actions.some((action) => action.startsWith("bedrock:InvokeModel")));
    expect(grants).toEqual([{ actions: ["bedrock:InvokeModel"], resources: ["{model:PHOTO}"] }]);
  });

  it("gives the Memory execution role only the extraction model (sid ExtractionModel)", () => {
    expect(SERVICE_ROLES.Memory.grants).toEqual([
      { sid: "ExtractionModel", actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], resources: ["{model:HARNESS}"] },
    ]);
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

  it("keeps the QA driver on QA, evaluation and the test judge, and the others off them", () => {
    for (const key of WORLDS_LEADING_KEYS.QaDriver) expect(key).toMatch(/qa-|eval-|isp-judge-test#/);
    for (const key of [...WORLDS_LEADING_KEYS.Bff, ...WORLDS_LEADING_KEYS.WorldJanitor]) expect(key).not.toMatch(/qa-|eval-/);
    for (const key of WORLDS_LEADING_KEYS.WorldJanitor) expect(key).toContain("isp-judge-");
  });
});

describe("QaDriver", () => {
  it("reads and deletes only from the DLQ and reads only the DLQ alarm history", () => {
    const grants = expectedGrants("QaDriver");
    const dlq = grants.find((grant) => grant.actions.includes("sqs:ReceiveMessage"));
    expect(dlq).toEqual({ actions: [...QA_DRIVER_DLQ_ONLY_ACTIONS], resources: ["{InstallerEventsDlq}"] });
    for (const fn of ROLES.filter((name) => name !== "QaDriver")) {
      for (const action of [...QA_DRIVER_DLQ_ONLY_ACTIONS, "cloudwatch:DescribeAlarmHistory", "sns:Publish"]) expect(expectedActions(fn), fn).not.toContain(action);
    }
  });

  it("publishes only on the app's own WhatsApp topic and writes only the kill switch of QA worlds", () => {
    const grants = expectedGrants("QaDriver");
    expect(grants.find((grant) => grant.actions.includes("sns:Publish"))?.resources).toEqual(["arn:aws:sns:us-east-1:776805327629:aws-cds-hackathon-poc-cuadrilla-wa-inbound"]);
    const kill = grants.find((grant) => grant.actions.includes("dynamodb:PutItem"));
    expect(kill?.conditions?.[0]?.values).toEqual(["KILL#AGENT#qa-*"]);
  });
});

describe("least privilege", () => {
  it("keeps SES, End User Messaging and Bedrock away from the console BFF", () => {
    expect(expectedActions("Bff").some((action) => /^(ses|social-messaging|bedrock):/.test(action))).toBe(false);
  });

  it("lets only the worker invoke the Harness and only CostGuard turn the global kill switch on", () => {
    expect(ROLES.filter((role) => expectedActions(role).includes("bedrock-agentcore:InvokeHarness"))).toEqual(["InstallerWorker"]);
    const cost = expectedGrants("CostGuard");
    expect(cost).toEqual([{ actions: ["dynamodb:PutItem"], resources: ["{Runtime}"], conditions: [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: ["KILL#*"] }] }]);
  });

  it("reports drift between generated and declared actions", () => {
    expect(actionDrift("DispatchMock", ["events:PutEvents"])).toEqual({ extra: [], missing: [] });
    expect(actionDrift("DispatchMock", ["events:PutEvents", "ses:SendEmail"])).toEqual({ extra: ["ses:SendEmail"], missing: [] });
    expect(actionDrift("ScheduleDispatch", [])).toEqual({ extra: [], missing: expectedActions("ScheduleDispatch") });
  });
});
