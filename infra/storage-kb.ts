// Knowledge Base of the procedures manual (docs/architecture.md §9.5, ADR-0005, docs/build-plan.md
// WP-21): Bedrock Knowledge Base with S3 Vectors as the vector store and Titan Text Embeddings v2
// (1024 dimensions, float32, cosine) over the `manual/` prefix of the `Manual` bucket
// (infra/storage-buckets.ts), the only source it ingests. Imported by sst.config.ts right after
// infra/storage.ts.
//
// Neither the vector bucket nor the Knowledge Base has an SST component: the vector store is
// `awsnative.s3vectors.*` (explicit tags: aws-native has no default tags, and the CI role fences
// everything by `sst:app`) and the Knowledge Base and its data source are `aws.bedrock.*` (default tags
// of sst.config.ts). They reach the Lambdas through the `KnowledgeBase` Linkable, which carries
// `bedrock:Retrieve` on this Knowledge Base and nothing else; `knowledgeBaseLinks(fn)` hands it exactly
// to the roles infra/iam-capabilities.ts grants `{KnowledgeBase}` (today `ToolKnowledge`). Ingestion
// (`StartIngestionJob`) is run by `seed:load` with the operator's or CI's credentials, never by a Lambda;
// it reads the ids from the same Linkable through `sst shell`.
//
// Layout of the source (docs/architecture-integrations.md §8): `manual/v<nnn>/<sectionId>.md`, one short
// section per file (≤ 800 tokens), next to its `<sectionId>.md.metadata.json` sidecar whose
// `metadataAttributes` (`sectionId`, `title`, `manualVersion`, `category`, `ispScope`) become filterable
// metadata of every chunk: `search_procedures` filters by `manualVersion` and cites `sectionId`. Fixed
// chunks of 600 tokens with 60 of overlap keep a section in one or two chunks; the section id travels in
// the metadata, never in the chunk text. The two keys Bedrock writes (chunk text and its own metadata)
// are declared non-filterable, as S3 Vectors requires for anything over its filterable-metadata limit.
//
// Names. S3 Vectors reserves every vector bucket name that starts with `aws` ("The requested bucket
// name is reserved") and the app name starts with `aws-`, so the vector bucket is `kb-<app>-<stage>-manual`,
// the shape the CI role and the permissions boundary fence (`bucket/kb-<app>-*`, infra/bootstrap); the
// deploy fails here if it would not fit in 63 characters.
//
// Service role: trust pinned to Bedrock of this account (`aws:SourceAccount`, `aws:SourceArn` of its
// knowledge bases: no other account's Bedrock can assume it); the embeddings model; list and read only
// `manual/`; the one vector index. IAM is eventually consistent, so the Knowledge Base `dependsOn` the
// role policy (without it the first create fails with AccessDenied on the index). Path and permissions
// boundary come from the $transform of infra/ci.ts.
//
// Cost: S3 Vectors bills per GB stored and per query, embeddings per token ingested; nothing bills by the
// hour while idle.
//
// Verify:
//   aws --profile craftech-demos bedrock-agent get-knowledge-base --knowledge-base-id <id>
//     → status ACTIVE, storageConfiguration.type S3_VECTORS
//   aws --profile craftech-demos bedrock-agent get-data-source --knowledge-base-id <id> --data-source-id <dsId>
//     → inclusionPrefixes ["manual/"], FIXED_SIZE 600 / 10 %, dataDeletionPolicy DELETE
//   aws --profile craftech-demos bedrock-agent list-ingestion-jobs --knowledge-base-id <id> --data-source-id <dsId>
//     → the last one COMPLETE (seed:load)
//   aws --profile craftech-demos s3vectors get-index --vector-bucket-name kb-aws-cds-hackathon-poc-cuadrilla-poc-manual --index-name manual

import { expectedGrants, type Grant, type LambdaName } from "./iam-capabilities";
import { MANUAL_PREFIX, manualBucket } from "./storage";
import { tagList } from "./tags";

/** Titan Text Embeddings v2 (docs/architecture.md §1). */
const EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";

export const KB_SPEC = {
  indexName: "manual",
  dataSourceName: "manual",
  dataType: "float32",
  dimensions: 1024,
  distanceMetric: "cosine",
  /** Keys Bedrock writes on every vector; filterable metadata is limited per vector in S3 Vectors. */
  nonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"],
  /** Sections of at most 800 tokens: fixed chunks of 600 tokens, 60 of them shared with the next. */
  chunking: { maxTokens: 600, overlapTokens: 60 },
} as const;

/** Bedrock takes the overlap of fixed-size chunks as a percentage of the chunk. */
export const CHUNK_OVERLAP_PERCENTAGE = Math.round((KB_SPEC.chunking.overlapTokens / KB_SPEC.chunking.maxTokens) * 100);

/** What the service role may do on its vector index (the Bedrock documentation's set, plus listing). */
const VECTOR_INDEX_ACTIONS = [
  "s3vectors:GetIndex",
  "s3vectors:QueryVectors",
  "s3vectors:PutVectors",
  "s3vectors:GetVectors",
  "s3vectors:ListVectors",
  "s3vectors:DeleteVectors",
] as const;

/** The only action a linked Lambda gets on the Knowledge Base. */
export const KNOWLEDGE_BASE_ACTIONS = ["bedrock:Retrieve"] as const;

/** Placeholder of infra/iam-capabilities.ts that stands for this Knowledge Base. */
const KNOWLEDGE_BASE_REF = "{KnowledgeBase}";

const VECTOR_BUCKET_NAME_MAX_LENGTH = 63;
// S3 Vectors: 3-63 lower-case letters, digits and hyphens, starting and ending with a letter or digit.
const VECTOR_BUCKET_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
// Bedrock Knowledge Base and data source names.
const BEDROCK_NAME = /^([0-9a-zA-Z][_-]?){1,100}$/;

/**
 * `kb-<app>-<stage>-manual`. Throws instead of truncating: a shorter or reshaped name would fall
 * outside the `bucket/kb-<app>-*` fence of the CI role, and a name starting with `aws` is reserved.
 */
export function vectorBucketName(app: string, stage: string): string {
  const name = `kb-${app}-${stage}-manual`;
  if (name.length > VECTOR_BUCKET_NAME_MAX_LENGTH || !VECTOR_BUCKET_NAME.test(name)) {
    throw new Error(
      `Vector bucket "${name}" must be at most ${VECTOR_BUCKET_NAME_MAX_LENGTH} lower-case letters, digits and hyphens ` +
        `(S3 Vectors), under the kb-<app>-* prefix the CI role is fenced to (infra/bootstrap/ci-role.yaml).`,
    );
  }
  return name;
}

/** `<app>-<stage>-manual`, the name the AWS console shows (docs/architecture.md §1). */
function knowledgeBaseName(app: string, stage: string): string {
  const name = `${app}-${stage}-manual`;
  if (!BEDROCK_NAME.test(name)) throw new Error(`Knowledge Base name "${name}" is not a valid Bedrock name.`);
  return name;
}

function embeddingModelArn(region: string): string {
  return `arn:aws:bedrock:${region}::foundation-model/${EMBEDDING_MODEL_ID}`;
}

/** Trust of the service role: Bedrock, only for knowledge bases of this account (confused deputy). */
function knowledgeBaseTrustPolicy(region: string, accountId: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BedrockKnowledgeBasesOfThisAccount",
        Effect: "Allow",
        Principal: { Service: "bedrock.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "aws:SourceAccount": accountId },
          ArnLike: { "aws:SourceArn": `arn:aws:bedrock:${region}:${accountId}:knowledge-base/*` },
        },
      },
    ],
  };
}

interface KnowledgeBaseRolePolicyInputs {
  readonly region: string;
  readonly accountId: string;
  readonly manualBucketArn: string;
  readonly indexArn: string;
}

/** Inline policy of the service role: embed, list and read `manual/`, and use the one vector index. */
function knowledgeBaseRolePolicy(inputs: KnowledgeBaseRolePolicyInputs) {
  const ownAccount = { StringEquals: { "aws:ResourceAccount": inputs.accountId } };
  return {
    Version: "2012-10-17",
    Statement: [
      { Sid: "InvokeEmbeddingModel", Effect: "Allow", Action: "bedrock:InvokeModel", Resource: embeddingModelArn(inputs.region) },
      {
        Sid: "ListManual",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: inputs.manualBucketArn,
        Condition: { ...ownAccount, StringLike: { "s3:prefix": [`${MANUAL_PREFIX}*`] } },
      },
      { Sid: "ReadManual", Effect: "Allow", Action: "s3:GetObject", Resource: `${inputs.manualBucketArn}/${MANUAL_PREFIX}*`, Condition: ownAccount },
      { Sid: "UseVectorIndex", Effect: "Allow", Action: [...VECTOR_INDEX_ACTIONS], Resource: inputs.indexArn },
    ],
  };
}

// ---- Resources -----------------------------------------------------------------------------------

const region = aws.getRegionOutput({}).region;
const accountId = aws.getCallerIdentityOutput({}).accountId;

const vectorBucket = new awsnative.s3vectors.VectorBucket("ManualVectorBucket", {
  vectorBucketName: vectorBucketName($app.name, $app.stage),
  encryptionConfiguration: { sseType: "AES256" },
  tags: tagList(),
});

const vectorIndex = new awsnative.s3vectors.Index(
  "ManualVectorIndex",
  {
    vectorBucketName: vectorBucket.vectorBucketName,
    indexName: KB_SPEC.indexName,
    dataType: KB_SPEC.dataType,
    dimension: KB_SPEC.dimensions,
    distanceMetric: KB_SPEC.distanceMetric,
    metadataConfiguration: { nonFilterableMetadataKeys: [...KB_SPEC.nonFilterableMetadataKeys] },
    tags: tagList(),
  },
  { dependsOn: [vectorBucket] },
);

const knowledgeBaseRole = new aws.iam.Role("ManualKnowledgeBaseRole", {
  description: "Bedrock Knowledge Base of the manual: reads manual/, embeds with Titan v2, writes its vector index.",
  assumeRolePolicy: $util.all([region, accountId]).apply(([regionName, account]) => JSON.stringify(knowledgeBaseTrustPolicy(regionName, account))),
});

const knowledgeBaseRolePolicyResource = new aws.iam.RolePolicy("ManualKnowledgeBaseRolePolicy", {
  role: knowledgeBaseRole.name,
  policy: $util
    .all([region, accountId, manualBucket.arn, vectorIndex.indexArn])
    .apply(([regionName, account, manualBucketArn, indexArn]) => JSON.stringify(knowledgeBaseRolePolicy({ region: regionName, accountId: account, manualBucketArn, indexArn }))),
});

const knowledgeBase = new aws.bedrock.AgentKnowledgeBase(
  "ManualKnowledgeBase",
  {
    name: knowledgeBaseName($app.name, $app.stage),
    description: "Installation procedures manual of the demo operator, written from scratch; search_procedures cites it by section.",
    roleArn: knowledgeBaseRole.arn,
    knowledgeBaseConfiguration: {
      type: "VECTOR",
      vectorKnowledgeBaseConfiguration: {
        embeddingModelArn: region.apply(embeddingModelArn),
        embeddingModelConfiguration: {
          bedrockEmbeddingModelConfiguration: { dimensions: KB_SPEC.dimensions, embeddingDataType: "FLOAT32" },
        },
      },
    },
    storageConfiguration: {
      type: "S3_VECTORS",
      s3VectorsConfiguration: { indexArn: vectorIndex.indexArn },
    },
  },
  // IAM propagation: created right after the policy, the Knowledge Base gets AccessDenied on the index.
  { dependsOn: [knowledgeBaseRolePolicyResource, vectorIndex] },
);

const manualDataSource = new aws.bedrock.AgentDataSource("ManualDataSource", {
  name: KB_SPEC.dataSourceName,
  knowledgeBaseId: knowledgeBase.id,
  description: `Markdown sections under ${MANUAL_PREFIX}v<nnn>/ with their metadata sidecars.`,
  // Vectors of a removed section go away on the next ingestion; the stage owns its data.
  dataDeletionPolicy: "DELETE",
  dataSourceConfiguration: {
    type: "S3",
    s3Configuration: {
      bucketArn: manualBucket.arn,
      bucketOwnerAccountId: accountId,
      inclusionPrefixes: [MANUAL_PREFIX],
    },
  },
  vectorIngestionConfiguration: {
    chunkingConfiguration: {
      chunkingStrategy: "FIXED_SIZE",
      fixedSizeChunkingConfiguration: { maxTokens: KB_SPEC.chunking.maxTokens, overlapPercentage: CHUNK_OVERLAP_PERCENTAGE },
    },
  },
});

/**
 * What `search_procedures` needs (`Resource.KnowledgeBase.id` for `Retrieve`) and what `seed:load`
 * needs to ingest (`dataSourceId`, `manualPrefix`). The included permission is read-only.
 */
export const KnowledgeBase = new sst.Linkable("KnowledgeBase", {
  properties: {
    id: knowledgeBase.id,
    arn: knowledgeBase.arn,
    dataSourceId: manualDataSource.dataSourceId,
    manualPrefix: MANUAL_PREFIX,
  },
  include: [sst.aws.permission({ actions: [...KNOWLEDGE_BASE_ACTIONS], resources: [knowledgeBase.arn] })],
});

const isRetrieveOnly = (grant: Grant): boolean =>
  grant.resources.length === 1 && grant.conditions === undefined && grant.actions.length === KNOWLEDGE_BASE_ACTIONS.length && KNOWLEDGE_BASE_ACTIONS.every((action) => grant.actions.includes(action));

/**
 * The link of a Lambda to the Knowledge Base: `[KnowledgeBase]` when infra/iam-capabilities.ts grants it
 * `{KnowledgeBase}`, nothing otherwise. A grant on `{KnowledgeBase}` other than `bedrock:Retrieve` fails
 * the deploy: the Linkable carries that action and nothing else.
 */
export function knowledgeBaseLinks(fn: LambdaName): Array<typeof KnowledgeBase> {
  const grants = expectedGrants(fn).filter((grant) => grant.resources.includes(KNOWLEDGE_BASE_REF));
  if (grants.length === 0) return [];
  const other = grants.find((grant) => !isRetrieveOnly(grant));
  if (other !== undefined) {
    throw new Error(`${fn}: infra/iam-capabilities.ts grants [${other.actions.join(", ")}] on ${KNOWLEDGE_BASE_REF}; the KnowledgeBase link carries ${KNOWLEDGE_BASE_ACTIONS.join(", ")} only.`);
  }
  return [KnowledgeBase];
}
