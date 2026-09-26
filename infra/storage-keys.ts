// Storage of the app as plain data and pure functions (docs/architecture.md §5-§6, docs/build-plan.md
// WP-06). No SST or Pulumi dependency: infra/storage-tables.ts and infra/storage-buckets.ts build the
// resources from this file, infra/storage.ts resolves the storage references of the IAM grants with
// it, and infra/storage-keys.test.ts checks every value against docs/architecture.md, the CI fences
// (ci-spec.ts) and iam-capabilities.ts without an AWS account.
//
// DynamoDB conventions (shared with the connector, packages/bff/src/connector/dynamo/):
//   - Every table is keyed by `PK` + `SK` (strings). Composite values live inside those two
//     attributes; the only other declared attributes are the keys of a GSI, all strings: DynamoDB
//     rejects a write whose GSI key attribute has another type.
//   - The TTL attribute is `expiresAt`, in EPOCH SECONDS (a Number). DynamoDB ignores a TTL value that
//     is not a Number, so an ISO string there would never expire. Every table but `Reference` has TTL.
//   - GSIs project every attribute. A sparse GSI is sparse because the writer omits its key attribute
//     (a timer that stops being SCHEDULED removes `clockDueKey`).
//
// S3 conventions: private, HTTPS-only, SSE-S3, incomplete multipart uploads aborted after 7 days.
// QA and evaluation worlds write under `qa/<runId>/` and `eval/<runId>/`, which expire in two days in
// the buckets they write to. The Seed bucket has an `eval/` prefix of its own (the evaluation set,
// kept for the life of the stage), so that rule never reaches it.

import type { BrowserBucket } from "./ci-spec";
import { expectedData, expectedTables, type BucketName, type LambdaName, type TableName } from "./iam-capabilities";

// ---- DynamoDB ----------------------------------------------------------------------------------

/** Tables of docs/architecture.md §5 that belong to the external mocks (infra/mocks.ts, WP-24). */
export const MOCK_TABLES = ["Network", "Dispatch"] as const satisfies readonly TableName[];
export type MockTable = (typeof MOCK_TABLES)[number];

/** Tables this module creates. */
export type StorageTable = Exclude<TableName, MockTable>;

export const PRIMARY_KEY = { hashKey: "PK", rangeKey: "SK" } as const;

/** TTL attribute of every table that expires items: epoch seconds (Number). */
export const TTL_ATTRIBUTE = "expiresAt";

export interface IndexSpec {
  readonly hashKey: string;
  readonly rangeKey?: string;
}

export interface TableSpec {
  /** Global secondary indexes by name (`GSI1`..`GSI4`), always projecting every attribute. */
  readonly indexes: Readonly<Record<string, IndexSpec>>;
  /** Whether DynamoDB deletes items once `expiresAt` passes. */
  readonly ttl: boolean;
}

/** SCHEDULED timers of a world by simulated due time; the same index in WorkOrders and Cases. */
const CLOCK_DUE_INDEX = { hashKey: "clockDueKey", rangeKey: "dueAtSim" } as const;

export const TABLE_SPECS = {
  // Isp, IspSettings, Zone, Crew, ShiftRoster, ConsoleUser. GSI1: console user by Cognito sub
  // (`SUB#<sub>`), the only source of the token's ispId and role.
  Isps: { indexes: { GSI1: { hashKey: "cognitoSubKey" } }, ttl: true },
  // Installer, Supervisor, ZoneChief, Customer, Consent, InstallerProfile, ShiftWindow, AddressClaim.
  // GSI1: identity by phone within a world (`<clockId>#<phoneHash>`); GSI2: people of an operator by
  // kind, sorted by name.
  People: {
    indexes: { GSI1: { hashKey: "phoneKey" }, GSI2: { hashKey: "ispKindKey", rangeKey: "sortName" } },
    ttl: true,
  },
  // WorkOrder, ChecklistItem, Evidence, PhotoValidation, TroubleshootingStep, Certificate, Timer.
  // GSI1: an installer's orders of a day; GSI2: an operator's orders of a day by status (console);
  // GSI3 (sparse): due timers; GSI4 (sparse): repeated photo within a world and its epoch.
  WorkOrders: {
    indexes: {
      GSI1: { hashKey: "installerDayKey", rangeKey: "windowStartSim" },
      GSI2: { hashKey: "ispDayKey", rangeKey: "status" },
      GSI3: CLOCK_DUE_INDEX,
      GSI4: { hashKey: "evidenceHash" },
    },
    ttl: true,
  },
  // Case and its CASE_TIMEOUT timers. GSI1: cases of an order; GSI2 (sparse): cases a supervisor took
  // (routes their messages); GSI3: the operator's inbox by status; GSI4 (sparse): due timers.
  Cases: {
    indexes: {
      GSI1: { hashKey: "workOrderKey", rangeKey: "createdAtSim" },
      GSI2: { hashKey: "takenByKey" },
      GSI3: { hashKey: "ispStatusKey", rangeKey: "createdAtSim" },
      GSI4: CLOCK_DUE_INDEX,
    },
    ttl: true,
  },
  // Message, MessageEvent, TurnNote, OutboundEmail. GSI1: message or email by provider id (WhatsApp
  // statuses, SES events); GSI2: timeline of an order.
  Conversations: {
    indexes: { GSI1: { hashKey: "providerMessageId" }, GSI2: { hashKey: "workOrderKey", rangeKey: "sentAtSim" } },
    ttl: true,
  },
  // Append-only decisions. GSI1: trail of an order; GSI2: an operator's decisions by kind.
  AuditLog: {
    indexes: { GSI1: { hashKey: "workOrderKey", rangeKey: "ts" }, GSI2: { hashKey: "decisionKey", rangeKey: "ts" } },
    ttl: true,
  },
  // Templates, rate card, name checks, rubric, safety lexicon, manual index, evaluation set. Kept.
  Reference: { indexes: {}, ttl: false },
  // Sessions, turns, nonces, clocks, idempotency, rates, caps, kill switch, leases, pendings, probes.
  Runtime: { indexes: {}, ttl: true },
  // KPIs per conversation and evaluation results.
  CuadrillaMetrics: { indexes: {}, ttl: true },
} as const satisfies Record<StorageTable, TableSpec>;

export const STORAGE_TABLES = Object.keys(TABLE_SPECS) as StorageTable[];

/** Attribute definitions of a table: its primary key and the keys of its GSIs, all strings. */
export function tableFields(spec: TableSpec): Record<string, "string"> {
  const fields: Record<string, "string"> = { [PRIMARY_KEY.hashKey]: "string", [PRIMARY_KEY.rangeKey]: "string" };
  for (const index of Object.values(spec.indexes)) {
    fields[index.hashKey] = "string";
    if (index.rangeKey !== undefined) fields[index.rangeKey] = "string";
  }
  return fields;
}

// ---- S3 ----------------------------------------------------------------------------------------

/**
 * S3 cannot be fenced by tag, so the CI deploy role reaches buckets by the name prefix
 * (ci-spec.ts `bucketPrefix`). SST truncates the app name inside a longer bucket name past that
 * prefix, so every component name stays at 16 characters or fewer (docs/architecture.md §6).
 */
export const BUCKET_LOGICAL_NAME_MAX_LENGTH = 16;

export const ABORT_MULTIPART_AFTER_DAYS = 7;

/** Prefixes of every key a QA or evaluation world writes (docs/architecture.md §6). */
export const QA_PREFIXES = ["qa/", "eval/"] as const;
export const QA_RETENTION_DAYS = 2;

/** Output of Transcribe: deleted as soon as it is read and masked; a one-day rule is the backstop. */
export const MEDIA_TRANSCRIPTS_PREFIX = "transcripts/";
export const TRANSCRIPTS_RETENTION_DAYS = 1;

/** Source of the manual's Knowledge Base (`manual/v<nnn>/<sectionId>.md` + metadata sidecar). */
export const MANUAL_PREFIX = "manual/";

/**
 * How a bucket is named. `sst`: SST's own name under the bucket prefix the CI role is fenced to.
 * `browser`: the fixed name the console's CSP allows (ci-spec.ts `browserBucketName`), for the
 * buckets the browser reaches with presigned URLs.
 */
export type BucketNaming = { readonly kind: "sst" } | { readonly kind: "browser"; readonly purpose: BrowserBucket };

export interface Expiration {
  /** Lifecycle rule id, unique within the bucket. */
  readonly id: string;
  /** Key prefix it applies to; omitted = every object of the bucket. */
  readonly prefix?: string;
  readonly days: number;
}

export interface BucketSpec {
  readonly naming: BucketNaming;
  /** Static start of every key layout of docs/architecture.md §6 (the code builds the rest). */
  readonly prefixes: readonly string[];
  /** Where two expirations overlap, S3 applies the earlier one. None = kept for the life of the stage. */
  readonly expirations: readonly Expiration[];
  /** The browser POSTs to it with a presigned form from the console origin (CORS). */
  readonly browserUploads: boolean;
}

const QA_EXPIRATIONS: readonly Expiration[] = QA_PREFIXES.map((prefix) => ({
  id: `expire-${prefix.slice(0, -1)}`,
  prefix,
  days: QA_RETENTION_DAYS,
}));

export const BUCKET_SPECS = {
  // WhatsApp media (live), the simulator's uploads and the output of Transcribe; 30 days.
  Media: {
    naming: { kind: "browser", purpose: "media" },
    prefixes: ["wa/", "sim/", MEDIA_TRANSCRIPTS_PREFIX],
    expirations: [
      { id: "expire", days: 30 },
      { id: "expire-transcripts", prefix: MEDIA_TRANSCRIPTS_PREFIX, days: TRANSCRIPTS_RETENTION_DAYS },
      ...QA_EXPIRATIONS,
    ],
    browserUploads: true,
  },
  // Validated photos (JPEG without metadata) and installation certificates; life of the stage.
  Evidence: {
    naming: { kind: "browser", purpose: "evidence" },
    prefixes: ["photos/", "certificates/"],
    expirations: QA_EXPIRATIONS,
    browserUploads: false,
  },
  // The procedures manual the Knowledge Base ingests; life of the stage.
  Manual: { naming: { kind: "sst" }, prefixes: [MANUAL_PREFIX], expirations: [], browserUploads: false },
  // World templates, synthetic photos and voice notes, evaluation set, Transcribe vocabulary, the
  // partner's logos (uploaded by the operator, never in git) and the template header sample.
  Seed: {
    naming: { kind: "browser", purpose: "seed" },
    prefixes: ["worlds/", "photos/", "audio/", "eval/", "transcribe/", "brand/", "templates/"],
    expirations: [],
    browserUploads: false,
  },
} as const satisfies Record<BucketName, BucketSpec>;

export const STORAGE_BUCKETS = Object.keys(BUCKET_SPECS) as BucketName[];

/** Throws unless `name` is a PascalCase component name the CI bucket fence can reach. */
export function assertBucketLogicalName(name: string): string {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || name.length > BUCKET_LOGICAL_NAME_MAX_LENGTH) {
    throw new Error(
      `Bucket component "${name}" must be PascalCase and at most ${BUCKET_LOGICAL_NAME_MAX_LENGTH} characters: ` +
        `SST would truncate the app name past the prefix the CI deploy role is fenced to (infra/ci-spec.ts).`,
    );
  }
  return name;
}

export interface LifecycleRule {
  readonly id: string;
  readonly status: "Enabled";
  readonly filter: { readonly prefix?: string };
  readonly expiration?: { readonly days: number };
  readonly abortIncompleteMultipartUpload?: { readonly daysAfterInitiation: number };
}

/** The lifecycle configuration of a bucket (one per bucket: S3 replaces, never merges). */
export function lifecycleRules(spec: BucketSpec): LifecycleRule[] {
  return [
    { id: "abort-incomplete-multipart", status: "Enabled", filter: {}, abortIncompleteMultipartUpload: { daysAfterInitiation: ABORT_MULTIPART_AFTER_DAYS } },
    ...spec.expirations.map(
      (expiration): LifecycleRule => ({
        id: expiration.id,
        status: "Enabled",
        filter: expiration.prefix === undefined ? {} : { prefix: expiration.prefix },
        expiration: { days: expiration.days },
      }),
    ),
  ];
}

export interface BrowserUploadCors {
  readonly allowOrigins: string[];
  readonly allowMethods: Array<"POST">;
  readonly allowHeaders: string[];
  readonly exposeHeaders: string[];
  readonly maxAgeSeconds: number;
}

/**
 * CORS of the bucket the browser POSTs to (docs/architecture.md §6): the phone simulator uploads
 * photos and recorded voice notes with a presigned POST. Only the console origin, only POST.
 */
export function browserUploadCors(appOrigin: string): BrowserUploadCors {
  return { allowOrigins: [appOrigin], allowMethods: ["POST"], allowHeaders: ["*"], exposeHeaders: [], maxAgeSeconds: 300 };
}

// ---- Storage per Lambda ------------------------------------------------------------------------

/** Buckets a function links, its capabilities included (iam-capabilities.ts). */
export function expectedBuckets(fn: LambdaName): BucketName[] {
  return (Object.keys(expectedData(fn, "buckets")) as BucketName[]).sort();
}

export interface StorageNeeds {
  /** Tables of this module to link. */
  readonly tables: StorageTable[];
  /** Tables of the mocks (infra/mocks.ts) the caller links on its own. */
  readonly mockTables: MockTable[];
  readonly buckets: BucketName[];
}

const isMockTable = (name: string): name is MockTable => (MOCK_TABLES as readonly string[]).includes(name);

/**
 * What a function links from storage, exactly as iam-capabilities.ts declares its data access. A
 * table or bucket a role reaches only through a fenced grant (`{Runtime}` of CostGuard, `{Seed}/*`
 * of WORLDS) is not here: `storageResource` in infra/storage.ts resolves those grants.
 */
export function storageFor(fn: LambdaName): StorageNeeds {
  const tables = Object.keys(expectedTables(fn)).sort() as TableName[];
  return {
    tables: tables.filter((name): name is StorageTable => !isMockTable(name)),
    mockTables: tables.filter(isMockTable),
    buckets: expectedBuckets(fn),
  };
}

// ---- Storage references of the IAM grants ------------------------------------------------------

/**
 * A storage placeholder of an iam-capabilities.ts grant: `{Runtime}` (the table), `{Runtime}/index/*`
 * (its GSIs), `{Media}` (the bucket), `{Evidence}/photos/*` (objects under a prefix) or `{Media.name}`
 * (the bucket's name, for conditions such as `transcribe:OutputBucketName`).
 */
export type StorageRef =
  | { readonly kind: "table"; readonly name: StorageTable; readonly indexes?: true }
  | { readonly kind: "bucket"; readonly name: BucketName; readonly objects?: string }
  | { readonly kind: "bucket-name"; readonly name: BucketName };

const PLACEHOLDER = /^\{([A-Za-z0-9]+)(\.name)?\}(?:\/(.+))?$/;
/** Suffix of a table placeholder that stands for every GSI of the table (`<table arn>/index/*`). */
export const TABLE_INDEXES = "index/*";

const isStorageTable = (name: string): name is StorageTable => (STORAGE_TABLES as string[]).includes(name);
const isStorageBucket = (name: string): name is BucketName => (STORAGE_BUCKETS as string[]).includes(name);

/**
 * Parses a grant resource. `undefined` when it is not a placeholder of this module (an ARN, `*`, or a
 * component of another module such as `{G1}` or `{InstallerEvents}`); throws on a storage placeholder
 * in a shape nothing resolves, so a typo fails the deploy instead of dropping a permission.
 */
export function parseStorageRef(resource: string): StorageRef | undefined {
  const match = PLACEHOLDER.exec(resource);
  const name = match?.[1];
  if (!match || name === undefined || (!isStorageTable(name) && !isStorageBucket(name))) return undefined;
  const attribute = match[2];
  const objects = match[3];
  if (isStorageTable(name) && attribute === undefined && objects === undefined) return { kind: "table", name };
  if (isStorageTable(name) && attribute === undefined && objects === TABLE_INDEXES) return { kind: "table", name, indexes: true };
  if (isStorageBucket(name) && attribute === undefined) return objects === undefined ? { kind: "bucket", name } : { kind: "bucket", name, objects };
  if (isStorageBucket(name) && objects === undefined) return { kind: "bucket-name", name };
  throw new Error(`Grant resource "${resource}" names storage in a shape infra/storage.ts cannot resolve.`);
}
