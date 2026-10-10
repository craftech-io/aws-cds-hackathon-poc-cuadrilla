import { describe, expect, it } from "vitest";
import { policyEngineName } from "../policy-rules";
import { allows, block, parameterBlock, read, statement, statementsOf, template } from "./template-text";

const PREFIX = "arn:${AWS::Partition}:";
const boundary = block(template, "  DeployBoundary:", "  DeploySstHomePolicy:");
const deployPolicies = block(template, "  DeploySstHomePolicy:", "  DeployRole:");

describe("fixed names of docs/architecture.md §1", () => {
  // Every fixed name, with the exact ARN (template form) a statement must name.
  const FIXED: ReadonlyArray<readonly [string, string, string]> = [
    ["aws-cds-hackathon-poc-cuadrilla-wa-inbound", "WhatsApp topic", `${PREFIX}sns:\${Region}:\${AWS::AccountId}:\${AppName}-wa-inbound"`],
    ["aws-cds-hackathon-poc-cuadrilla-github-deploy", "deploy role", `${PREFIX}iam::\${AWS::AccountId}:role/\${AppName}-github-deploy"`],
    ["aws-cds-hackathon-poc-cuadrilla-qa-runner", "qa-runner role", `${PREFIX}iam::\${AWS::AccountId}:role/\${AppName}-qa-runner"`],
    ["aws-cds-hackathon-poc-cuadrilla-ci-boundary", "boundary", `${PREFIX}iam::\${AWS::AccountId}:policy/\${AppName}-ci-boundary"`],
    ["/aws-cds-hackathon-poc-cuadrilla/", "IAM path", `${PREFIX}iam::\${AWS::AccountId}:role/\${AppName}/*"`],
    ["aws-cds-hackathon-poc-cuadrilla-poc-qa-driver", "QA function", `${PREFIX}lambda:\${Region}:\${AWS::AccountId}:function:\${AppName}-\${DeployStage}-qa-driver"`],
    ["aws-cds-hackathon-poc-cuadrilla-email-poc", "email configuration set", `${PREFIX}ses:\${Region}:\${AWS::AccountId}:configuration-set/\${AppName}-email-\${DeployStage}"`],
    ["aws-cds-hackathon-poc-cuadrilla-poc-schedules", "schedule group", `${PREFIX}scheduler:\${Region}:\${AWS::AccountId}:schedule-group/\${AppName}-*"`],
    ["kb-aws-cds-hackathon-poc-cuadrilla-poc-manual", "vector bucket", `${PREFIX}s3vectors:\${Region}:\${AWS::AccountId}:bucket/kb-\${AppName}-*"`],
    ["cuadrilla-poc-ftth-es-mx", "Transcribe vocabulary", `${PREFIX}transcribe:\${Region}:\${AWS::AccountId}:vocabulary/cuadrilla-poc-*"`],
    ["cuadrilla-poc-<sha256", "Transcribe jobs", `${PREFIX}transcribe:\${Region}:\${AWS::AccountId}:transcription-job/cuadrilla-poc-*"`],
    ["aws-cds-hackathon-poc-cuadrilla-poc-edge", "edge web ACL", `${PREFIX}wafv2:\${Region}:\${AWS::AccountId}:global/webacl/\${AppName}-*"`],
    ["aws-cds-hackathon-poc-cuadrilla-poc-auth", "user pool web ACL", `${PREFIX}wafv2:\${Region}:\${AWS::AccountId}:regional/webacl/\${AppName}-*"`],
    ["aws-cds-hackathon-poc-cuadrilla-poc-guest-account-deletion", "account deletion", `${PREFIX}lambda:\${Region}:\${AWS::AccountId}:function:\${AppName}-\${DeployStage}-guest-account-deletion"`],
  ];
  const architecture = read("docs/architecture.md");
  const statements = statementsOf(template);

  it.each(FIXED)("%s (%s) is in docs/architecture.md and covered by a statement with its exact ARN", (name, _what, arn) => {
    expect(architecture).toContain(name);
    expect(statements.some(({ body }) => body.includes(arn)), arn).toBe(true);
  });
});

describe("Transcribe vocabulary and jobs (ADR-0009)", () => {
  // Actions with no resource type in the Service Authorization Reference: the only ones allowed on "*".
  const WILDCARD_TRANSCRIBE = ["CreateVocabulary", "ListTagsForResource", "StartTranscriptionJob", "TagResource", "UntagResource"];

  it("grants transcribe:* on Resource * only for the actions IAM offers no resource type for", () => {
    for (const { sid, body } of allows.filter(({ body }) => body.includes("transcribe:"))) {
      const actions = [...body.matchAll(/transcribe:(\w+)/g)].map((match) => match[1] ?? "");
      if (body.includes('Resource: "*"')) for (const action of actions) expect(WILDCARD_TRANSCRIBE, `${sid}: ${action}`).toContain(action);
      else expect(body, sid).toMatch(/(vocabulary|transcription-job)\/cuadrilla-poc-\*"/);
    }
  });

  it.each([
    ["the deploy role", deployPolicies],
    ["the boundary", boundary],
  ])("fences the vocabulary the same way in %s", (_where, policy) => {
    const local = statementsOf(policy);
    const find = (sid: string): string => local.find((candidate) => candidate.sid === sid)?.body ?? "";
    const create = find("NoResourceLevelDeployVocabularyCreate");
    expect(create).toContain("- transcribe:CreateVocabulary");
    expect(create).toContain("- transcribe:TagResource");
    expect(create).toContain("aws:RequestTag/Project: !Ref AppName");
    const keys = find("NoResourceLevelDeployVocabularyTagKeys");
    expect(keys).toContain("- transcribe:UntagResource");
    expect(keys).toContain("ForAllValues:StringEquals:");
    expect(keys).toContain('aws:TagKeys: [Project, Stage, ManagedBy, Owner, "sst:app", "sst:stage"]');
    expect(find("NoResourceLevelDeployVocabularyTagReads")).toContain("Action: transcribe:ListTagsForResource");
    const byArn = find("VocabulariesOfThisApp");
    for (const action of ["GetVocabulary", "UpdateVocabulary", "DeleteVocabulary"]) expect(byArn).toContain(`- transcribe:${action}`);
  });

  it("lets app roles start jobs (fenced by bucket and key in infra/iam-capabilities.ts) and read or delete only their own", () => {
    expect(block(boundary, "Sid: NoResourceLevelRuntime", "- Sid:")).toContain("- transcribe:StartTranscriptionJob");
    expect(statement("TranscriptionJobsOfThisApp")).toContain("transcription-job/cuadrilla-poc-*");
    expect(deployPolicies).not.toContain("StartTranscriptionJob");
  });
});

describe("End User Messaging Social (ADR-0002)", () => {
  it("fences WhatsApp to the number of the WhatsAppPhoneNumberArn parameter, omitted while it is empty", () => {
    const parameter = parameterBlock("WhatsAppPhoneNumberArn");
    expect(parameter).toContain('Default: ""');
    expect(parameter).toContain("phone-number-id/[0-9a-f]{32})$");
    expect(template).toContain('HasWhatsAppPhoneNumber: !Not [!Equals [!Ref WhatsAppPhoneNumberArn, ""]]');
    const whatsapp = block(boundary, "- !If\n            - HasWhatsAppPhoneNumber", "- !Ref AWS::NoValue");
    expect(whatsapp).toContain("Resource: !Ref WhatsAppPhoneNumberArn");
    for (const action of ["SendWhatsAppMessage", "PostWhatsAppMessageMedia", "GetWhatsAppMessageMedia"]) expect(whatsapp).toContain(`social-messaging:${action}`);
  });

  it("never names every number of the account and never touches WABA event destinations or associations", () => {
    expect(template).not.toContain("phone-number-id/*");
    expect(template).not.toMatch(/PutWhatsAppBusinessAccountEventDestinations|AssociateWhatsAppBusinessAccount|social-messaging:\*/);
    expect(deployPolicies).not.toContain("social-messaging:");
  });
});

describe("qa-runner", () => {
  const role = block(template, "  QaRunnerRole:", "Outputs:");

  it("only invokes the QA driver of the deploy stage and reads the app's logs", () => {
    const actions = [...role.matchAll(/Action: ([\w:-]+)/g)].map((match) => match[1]);
    expect([...new Set(actions)].sort()).toEqual(["lambda:InvokeFunction", "logs:FilterLogEvents", "sts:AssumeRoleWithWebIdentity"]);
    expect(statement("InvokeTheQaDriverOnly")).toContain("function:${AppName}-${DeployStage}-qa-driver");
    expect(statement("ReadLogsOfThisApp")).toContain("aws:ResourceTag/sst:app: !Ref AppName");
  });

  it("trusts deploy.yml and scenarios.yml on main, nothing else", () => {
    const refs = role.split("\n").filter((line) => line.includes("job_workflow_ref") || line.includes(".github/workflows/"));
    expect(refs.join("\n")).toContain("deploy.yml@refs/heads/${DeployBranch}");
    expect(refs.join("\n")).toContain("scenarios.yml@refs/heads/${DeployBranch}");
    expect(refs.filter((line) => line.includes(".github/workflows/"))).toHaveLength(2);
  });

  it("lasts two hours, so one measurement of scenarios.yml keeps its credentials; the deploy role, one", () => {
    expect(role).toContain("MaxSessionDuration: 7200");
    expect(block(template, "  DeployRole:", "AssumeRolePolicyDocument:")).toContain("MaxSessionDuration: 3600");
  });
});

describe("services this app adds to the scaffolding", () => {
  it("fences the Feeds event buses by the app name", () => {
    const buses = statement("EventBusesOfThisApp");
    for (const action of ["events:CreateEventBus", "events:DeleteEventBus", "events:TagResource"]) expect(buses).toContain(action);
    expect(buses).toContain('event-bus/${AppName}-*"');
  });

  it("allows a public (NONE) Function URL only on the BFF: the mocks and the QA driver stay AWS_IAM", () => {
    const deny = statement("DenyPublicFunctionUrlsBesidesTheEdge");
    expect(deny).toContain("Effect: Deny");
    for (const action of ["lambda:CreateFunctionUrlConfig", "lambda:UpdateFunctionUrlConfig", "lambda:AddPermission"]) expect(deny).toContain(action);
    expect(deny).toContain("lambda:FunctionUrlAuthType: NONE");
    expect(deny).toContain("function:${AppName}-${DeployStage}-BffFunction-*");
    expect(deny.match(/function:/g)).toHaveLength(1);
  });

  it("manages only the project's budget and denies every other", () => {
    expect(statement("ProjectBudget")).toContain('budget/${AppName}-*"');
    const deny = statement("DenyBudgetsOfOtherProjects");
    expect(deny).toContain("NotResource:");
    expect(deny).toContain('budget/${AppName}-*"');
  });

  it("creates the manual's Knowledge Base only tagged as the app and its vector bucket only by name", () => {
    expect(statement("CreateTaggedAsThisApp")).toContain("bedrock:CreateKnowledgeBase");
    for (const policy of [boundary, deployPolicies]) {
      const named = statementsOf(policy).filter(({ body }) => body.includes("s3vectors:*"));
      expect(named).toHaveLength(1);
      expect(named[0]?.body).toContain("bucket/kb-${AppName}-*");
    }
  });

  it("names the app's buckets by the prefix, so the deploy reads the vocabulary file under Seed/transcribe/", () => {
    const named = block(deployPolicies, "Sid: NamedAppResources", "- Sid: SesNamedAppResources");
    expect(named).toContain("- s3:*");
    expect(named).toContain('s3:::${BucketPrefix}*"');
  });
});

describe("Cedar policies (names unique across every engine of the shared account)", () => {
  const PARAMETERS: Readonly<Record<string, string>> = {
    "AWS::Partition": "aws",
    "AWS::AccountId": "776805327629",
    Region: "us-east-1",
    AgentNamePrefix: /Default: (\S+)/.exec(parameterBlock("AgentNamePrefix"))?.[1] ?? "",
    DeployStage: /Default: (\S+)/.exec(parameterBlock("DeployStage"))?.[1] ?? "",
  };
  const engineArn = (id: string): string => `arn:aws:bedrock-agentcore:us-east-1:776805327629:policy-engine/${id}`;
  const OWN_ENGINE = engineArn(`${policyEngineName("aws-cds-hackathon-poc-cuadrilla", "poc")}-a1B2c3D4e5`);
  const OTHER_ENGINES = [engineArn("other_poc_app_poc-z9Y8x7W6v5"), engineArn("aws_cds_hackathon_poc_other_poc-z9Y8x7W6v5")];
  const POLICY_ACTION = /bedrock-agentcore:(\*|Create\*|CreatePolicy|DeletePolicy|GetPolicy|UpdatePolicy)$/m;
  const grants = allows.filter(({ body }) => POLICY_ACTION.test(body));
  /** The statement's ARN patterns with the template parameters substituted, as regular expressions. */
  const patterns = (body: string): RegExp[] =>
    [...body.matchAll(/!Sub "(arn:[^"]+)"/g)].map((match) => {
      const arn = (match[1] ?? "").replace(/\$\{([^}]+)\}/g, (_all, name: string) => PARAMETERS[name] ?? `\${${name}}`);
      return new RegExp(`^${arn.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    });
  const granted = (arn: string): boolean => grants.some(({ body }) => patterns(body).some((pattern) => pattern.test(arn)));

  it("grants the policy actions on Resource * only behind the app's tag", () => {
    expect(grants.length).toBeGreaterThan(0);
    for (const { sid, body } of grants.filter(({ body }) => body.includes('Resource: "*"'))) expect(body, sid).toMatch(/aws:(Resource|Request)Tag\/sst:app: !Ref AppName/);
  });

  it("creates, reads, updates and deletes policies of this app's engine, the engine ARN included", () => {
    expect(statement("CedarPoliciesOfThisAppsEngine")).toContain("policy-engine/${AgentNamePrefix}_${DeployStage}*");
    for (const arn of [OWN_ENGINE, `${OWN_ENGINE}/policy/cuadrilla_poc_CED_NO_OVERRIDE-q1W2e3R4t5`]) expect(granted(arn), arn).toBe(true);
  });

  it("never grants them on another app's engine or its policies", () => {
    expect(template).not.toContain("policy-engine/*");
    for (const engine of OTHER_ENGINES) for (const arn of [engine, `${engine}/policy/cuadrilla_poc_CED_NO_OVERRIDE-q1W2e3R4t5`]) expect(granted(arn), arn).toBe(false);
  });
});
