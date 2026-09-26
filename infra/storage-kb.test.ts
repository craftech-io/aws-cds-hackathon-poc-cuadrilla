// infra/storage-kb.ts only evaluates inside the SST program ($app, sst, aws, awsnative, $util), so this
// test evaluates it against a recording fake of those globals: every component it creates is kept with
// its arguments and options, and every Output is a promise the test resolves. What is asserted is what
// the module hands to S3 Vectors, IAM and Bedrock, not its source text.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LAMBDA_CAPABILITIES, expectedGrants, type LambdaName } from "./iam-capabilities";
import { MANUAL_PREFIX } from "./storage-keys";

const APP = "aws-cds-hackathon-poc-cuadrilla";
const ACCOUNT = "111111111111";
const MANUAL_BUCKET = "aws-cds-hackathon-poc-cuadrilla-poc-manualbucket-abcd1234";
const MANUAL_ARN = `arn:aws:s3:::${MANUAL_BUCKET}`;
const KB_ID = "KBID123456";
const KB_ARN = `arn:aws:bedrock:us-east-1:${ACCOUNT}:knowledge-base/${KB_ID}`;

// ---- A recording SST runtime ----------------------------------------------------------------------

class FakeOutput {
  readonly promise: Promise<unknown>;
  constructor(promise: Promise<unknown>) {
    this.promise = promise;
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
  readonly opts: { dependsOn?: unknown[] } | undefined;
  readonly instance: object;
}

function fakeRuntime() {
  const created: Created[] = [];
  const recorder = (type: string, outputs: (name: string, args: Record<string, unknown>) => Record<string, unknown> = () => ({})) =>
    class {
      constructor(name: string, args: Record<string, unknown>, opts?: { dependsOn?: unknown[] }) {
        Object.assign(this, outputs(name, args));
        created.push({ type, name, args, opts, instance: this });
      }
    };
  const sst = {
    Linkable: recorder("sst.Linkable"),
    aws: { permission: (input: object) => ({ type: "aws.permission", ...input }) },
  };
  const aws = {
    getRegionOutput: () => ({ region: output("us-east-1") }),
    getCallerIdentityOutput: () => ({ accountId: output(ACCOUNT) }),
    iam: {
      Role: recorder("aws.iam.Role", (name) => ({ name: output(`${name}-r4nd0m`), arn: output(`arn:aws:iam::${ACCOUNT}:role/${APP}/${name}-r4nd0m`) })),
      RolePolicy: recorder("aws.iam.RolePolicy"),
    },
    bedrock: {
      AgentKnowledgeBase: recorder("aws.bedrock.AgentKnowledgeBase", () => ({ id: output(KB_ID), arn: output(KB_ARN) })),
      AgentDataSource: recorder("aws.bedrock.AgentDataSource", () => ({ dataSourceId: output("DSID123456") })),
    },
  };
  const awsnative = {
    s3vectors: {
      VectorBucket: recorder("awsnative.s3vectors.VectorBucket", (_name, args) => ({ vectorBucketName: output(args.vectorBucketName) })),
      Index: recorder("awsnative.s3vectors.Index", (_name, args) => ({
        indexArn: output(args.vectorBucketName).apply((bucket: string) => `arn:aws:s3vectors:us-east-1:${ACCOUNT}:bucket/${bucket}/index/${String(args.indexName)}`),
      })),
    },
  };
  const util = { output, all: (values: unknown[]) => new FakeOutput(Promise.all(values.map((value) => output(value).promise))) };
  const interpolate = (strings: TemplateStringsArray, ...values: unknown[]) =>
    new FakeOutput(Promise.all(values.map((value) => output(value).promise)).then((parts) => strings.reduce((text, piece, i) => `${text}${piece}${i < parts.length ? String(parts[i]) : ""}`, "")));
  return { sst, aws, awsnative, util, interpolate, created };
}

async function resolveDeep(value: unknown): Promise<unknown> {
  if (value instanceof FakeOutput) return resolveDeep(await value.promise);
  if (Array.isArray(value)) return Promise.all(value.map(resolveDeep));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = await Promise.all(Object.entries(value).map(async ([key, inner]) => [key, await resolveDeep(inner)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

const manualBucket = { arn: output(MANUAL_ARN), name: output(MANUAL_BUCKET) };

async function evaluate(app = { name: APP, stage: "poc" }) {
  const runtime = fakeRuntime();
  vi.resetModules();
  vi.stubGlobal("$app", app);
  vi.stubGlobal("sst", runtime.sst);
  vi.stubGlobal("aws", runtime.aws);
  vi.stubGlobal("awsnative", runtime.awsnative);
  vi.stubGlobal("$util", runtime.util);
  vi.stubGlobal("$interpolate", runtime.interpolate);
  // infra/storage.ts is real; only its resources are fakes.
  vi.doMock("./storage-tables", () => ({ tables: {} }));
  vi.doMock("./storage-buckets", () => ({ buckets: { Manual: manualBucket }, manualBucket, mediaBucket: {}, evidenceBucket: {}, seedBucket: {} }));
  const module = await import("./storage-kb");
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
});

const architecture = readFileSync(resolve(process.cwd(), "docs/architecture.md"), "utf8");
const template = readFileSync(resolve(process.cwd(), "infra/bootstrap/ci-role.yaml"), "utf8");
const LAMBDAS = Object.keys(LAMBDA_CAPABILITIES) as LambdaName[];

// ---- Names ----------------------------------------------------------------------------------------

describe("names of the manual's vector store", () => {
  it("names the vector bucket kb-<app>-<stage>-manual, inside the CI fence and S3 Vectors' 63 characters", async () => {
    const { module, only } = await evaluate();
    const name = module.vectorBucketName(APP, "poc");
    expect(name).toBe("kb-aws-cds-hackathon-poc-cuadrilla-poc-manual");
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith("aws")).toBe(false);
    expect(template).toContain("bucket/kb-${AppName}-*");
    expect(name.startsWith(`kb-${APP}-`)).toBe(true);
    expect(only("awsnative.s3vectors.VectorBucket").args.vectorBucketName).toBe(name);
    expect(architecture).toContain(`\`${name}\``);
  });

  it("fails the deploy instead of truncating a name over 63 characters or outside the alphabet", async () => {
    const { module } = await evaluate();
    expect(() => module.vectorBucketName("a".repeat(52), "poc")).toThrow(/at most 63/);
    expect(() => module.vectorBucketName("App_Name", "poc")).toThrow(/lower-case/);
    await expect(evaluate({ name: `${APP}-${"x".repeat(20)}`, stage: "poc" })).rejects.toThrow(/Vector bucket/);
  });

  it("names the Knowledge Base as docs/architecture.md §1 does", async () => {
    const { only } = await evaluate();
    const kb = only("aws.bedrock.AgentKnowledgeBase").args;
    expect(kb.name).toBe("aws-cds-hackathon-poc-cuadrilla-poc-manual");
    expect(architecture).toContain("| Knowledge Base | `aws-cds-hackathon-poc-cuadrilla-poc-manual` |");
  });
});

// ---- Vector store -----------------------------------------------------------------------------------

describe("vector bucket and index", () => {
  it("creates one tagged vector bucket with SSE-S3 and one index manual: float32, 1024, cosine", async () => {
    const { created, only } = await evaluate();
    const bucket = only("awsnative.s3vectors.VectorBucket");
    expect(bucket.args.encryptionConfiguration).toEqual({ sseType: "AES256" });
    const index = only("awsnative.s3vectors.Index");
    expect(await resolveDeep(index.args)).toMatchObject({
      vectorBucketName: "kb-aws-cds-hackathon-poc-cuadrilla-poc-manual",
      indexName: "manual",
      dataType: "float32",
      dimension: 1024,
      distanceMetric: "cosine",
    });
    expect(index.opts?.dependsOn).toContain(bucket.instance);
    for (const entry of created.filter((item) => item.type.startsWith("awsnative."))) {
      const tags = Object.fromEntries((entry.args.tags as Array<{ key: string; value: string }>).map((tag) => [tag.key, tag.value]));
      expect(tags, entry.name).toEqual({ Project: APP, Stage: "poc", ManagedBy: "sst", Owner: "craftech", "sst:app": APP, "sst:stage": "poc" });
    }
  });

  it("keeps Bedrock's two keys non-filterable and every sidecar key filterable (search_procedures filters by manualVersion)", async () => {
    const { only } = await evaluate();
    const keys = (only("awsnative.s3vectors.Index").args.metadataConfiguration as { nonFilterableMetadataKeys: string[] }).nonFilterableMetadataKeys;
    expect(keys).toEqual(["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"]);
    for (const key of ["sectionId", "title", "manualVersion", "category", "ispScope"]) {
      expect(architecture).toContain(key);
      expect(keys).not.toContain(key);
    }
  });
});

// ---- Service role -----------------------------------------------------------------------------------

describe("service role of the Knowledge Base", () => {
  it("trusts Bedrock only for knowledge bases of this account", async () => {
    const { only } = await evaluate();
    const role = only("aws.iam.Role");
    const trust = JSON.parse((await resolveDeep(role.args.assumeRolePolicy)) as string);
    expect(trust.Statement).toEqual([
      {
        Sid: "BedrockKnowledgeBasesOfThisAccount",
        Effect: "Allow",
        Principal: { Service: "bedrock.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "aws:SourceAccount": ACCOUNT },
          ArnLike: { "aws:SourceArn": `arn:aws:bedrock:us-east-1:${ACCOUNT}:knowledge-base/*` },
        },
      },
    ]);
    // Path and boundary are infra/ci.ts's: a module that sets its own is denied the creation.
    expect(role.args).not.toHaveProperty("path");
    expect(role.args).not.toHaveProperty("permissionsBoundary");
  });

  it("lets it embed with Titan v2, list and read manual/ only, and use its one index", async () => {
    const { only } = await evaluate();
    const policy = only("aws.iam.RolePolicy");
    const document = JSON.parse((await resolveDeep(policy.args.policy)) as string);
    const indexArn = `arn:aws:s3vectors:us-east-1:${ACCOUNT}:bucket/kb-aws-cds-hackathon-poc-cuadrilla-poc-manual/index/manual`;
    const ownAccount = { StringEquals: { "aws:ResourceAccount": ACCOUNT } };
    expect(document.Statement).toEqual([
      { Sid: "InvokeEmbeddingModel", Effect: "Allow", Action: "bedrock:InvokeModel", Resource: "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0" },
      { Sid: "ListManual", Effect: "Allow", Action: "s3:ListBucket", Resource: MANUAL_ARN, Condition: { ...ownAccount, StringLike: { "s3:prefix": ["manual/*"] } } },
      { Sid: "ReadManual", Effect: "Allow", Action: "s3:GetObject", Resource: `${MANUAL_ARN}/manual/*`, Condition: ownAccount },
      {
        Sid: "UseVectorIndex",
        Effect: "Allow",
        Action: ["s3vectors:GetIndex", "s3vectors:QueryVectors", "s3vectors:PutVectors", "s3vectors:GetVectors", "s3vectors:ListVectors", "s3vectors:DeleteVectors"],
        Resource: indexArn,
      },
    ]);
    const text = JSON.stringify(document);
    expect(text).not.toMatch(/"Resource":"\*"|"Action":"[a-z0-9-]+:\*"|s3:PutObject|s3:DeleteObject|s3vectors:\*|bedrock:\*/);
    expect(await resolveDeep(policy.args.role)).toBe("ManualKnowledgeBaseRole-r4nd0m");
  });
});

// ---- Knowledge Base and data source -----------------------------------------------------------------

describe("Knowledge Base and data source", () => {
  it("stores in the S3 Vectors index with Titan v2 at 1024 float32, created after the role policy", async () => {
    const { only } = await evaluate();
    const kb = only("aws.bedrock.AgentKnowledgeBase");
    expect(await resolveDeep(kb.args)).toMatchObject({
      roleArn: `arn:aws:iam::${ACCOUNT}:role/${APP}/ManualKnowledgeBaseRole-r4nd0m`,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0",
          embeddingModelConfiguration: { bedrockEmbeddingModelConfiguration: { dimensions: 1024, embeddingDataType: "FLOAT32" } },
        },
      },
      storageConfiguration: {
        type: "S3_VECTORS",
        s3VectorsConfiguration: { indexArn: `arn:aws:s3vectors:us-east-1:${ACCOUNT}:bucket/kb-aws-cds-hackathon-poc-cuadrilla-poc-manual/index/manual` },
      },
    });
    expect(kb.opts?.dependsOn).toContain(only("aws.iam.RolePolicy").instance);
    expect(kb.opts?.dependsOn).toContain(only("awsnative.s3vectors.Index").instance);
  });

  it("ingests only Manual/manual/ in fixed chunks of 600 tokens with 60 of overlap, deleting vectors of removed sections", async () => {
    const { only, module } = await evaluate();
    const source = only("aws.bedrock.AgentDataSource");
    expect(await resolveDeep(source.args)).toMatchObject({
      name: "manual",
      knowledgeBaseId: KB_ID,
      dataDeletionPolicy: "DELETE",
      dataSourceConfiguration: { type: "S3", s3Configuration: { bucketArn: MANUAL_ARN, bucketOwnerAccountId: ACCOUNT, inclusionPrefixes: [MANUAL_PREFIX] } },
      vectorIngestionConfiguration: {
        chunkingConfiguration: { chunkingStrategy: "FIXED_SIZE", fixedSizeChunkingConfiguration: { maxTokens: 600, overlapPercentage: 10 } },
      },
    });
    expect(MANUAL_PREFIX).toBe("manual/");
    expect(module.CHUNK_OVERLAP_PERCENTAGE * module.KB_SPEC.chunking.maxTokens).toBe(module.KB_SPEC.chunking.overlapTokens * 100);
    expect(architecture).toContain("`FIXED_SIZE` de 600 tokens con 60 de solapamiento");
    expect(architecture).toContain("`dataDeletionPolicy DELETE`");
  });

  it("creates nothing but the vector store, the role and its policy, the Knowledge Base, its data source and the link", async () => {
    const { created } = await evaluate();
    expect(created.map((entry) => entry.type).sort()).toEqual(
      [
        "aws.bedrock.AgentDataSource",
        "aws.bedrock.AgentKnowledgeBase",
        "aws.iam.Role",
        "aws.iam.RolePolicy",
        "awsnative.s3vectors.Index",
        "awsnative.s3vectors.VectorBucket",
        "sst.Linkable",
      ].sort(),
    );
  });
});

// ---- Link -------------------------------------------------------------------------------------------

describe("KnowledgeBase link", () => {
  it("includes bedrock:Retrieve on this Knowledge Base and nothing else", async () => {
    const { only } = await evaluate();
    const link = only("sst.Linkable");
    expect(link.name).toBe("KnowledgeBase");
    expect(await resolveDeep(link.args.include)).toEqual([{ type: "aws.permission", actions: ["bedrock:Retrieve"], resources: [KB_ARN] }]);
  });

  it("hands search_procedures the id and seed:load the data source and the source prefix", async () => {
    const { only } = await evaluate();
    expect(await resolveDeep(only("sst.Linkable").args.properties)).toEqual({ id: KB_ID, arn: KB_ARN, dataSourceId: "DSID123456", manualPrefix: "manual/" });
  });

  it("is linked exactly to the roles iam-capabilities.ts grants {KnowledgeBase}, with the same single action", async () => {
    const { module } = await evaluate();
    const linked = LAMBDAS.filter((fn) => module.knowledgeBaseLinks(fn).length > 0);
    expect(linked).toEqual(["ToolKnowledge"]);
    expect(module.knowledgeBaseLinks("ToolKnowledge")).toEqual([module.KnowledgeBase]);
    for (const fn of LAMBDAS) {
      const onKb = expectedGrants(fn).filter((grant) => grant.resources.includes("{KnowledgeBase}"));
      expect(onKb.length > 0, fn).toBe(linked.includes(fn));
      for (const grant of onKb) expect(grant.actions).toEqual([...module.KNOWLEDGE_BASE_ACTIONS]);
    }
    expect(architecture).toContain("| `ToolKnowledge` | `bedrock:Retrieve` (Linkable `KnowledgeBase`)");
  });

  it("fails the deploy when a role is granted anything but bedrock:Retrieve on {KnowledgeBase}", async () => {
    vi.doMock("./iam-capabilities", async (importOriginal) => {
      const original = await importOriginal<typeof import("./iam-capabilities")>();
      return {
        ...original,
        expectedGrants: (role: LambdaName) =>
          role === "ToolKnowledge" ? [{ actions: ["bedrock:Retrieve", "bedrock:StartIngestionJob"], resources: ["{KnowledgeBase}"] }] : original.expectedGrants(role),
      };
    });
    try {
      const { module } = await evaluate();
      expect(() => module.knowledgeBaseLinks("ToolKnowledge")).toThrow(/carries bedrock:Retrieve only/);
      expect(module.knowledgeBaseLinks("Bff")).toEqual([]);
    } finally {
      vi.doUnmock("./iam-capabilities");
    }
  });
});
