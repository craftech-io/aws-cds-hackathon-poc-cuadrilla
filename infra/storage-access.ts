// Data access of every Lambda as exact IAM statements (docs/architecture.md §14). Plain data and pure
// functions, except `linkNameOnly`, which only runs inside the SST program.
//
// A linked sst.aws.Dynamo or sst.aws.Bucket would put `dynamodb:*` / `s3:*` on the table, the bucket
// and everything under them into the role (DeleteTable, UpdateTable, PutBucketPolicy,
// PutPublicAccessBlock…), whatever access iam-capabilities.ts declares. So sst.config.ts calls
// `linkNameOnly()` before any module runs: a link hands the Lambda the name (`Resource.<Name>.name`)
// and no permission, and each module adds `storagePermissions(fn)` (infra/storage.ts), built here
// from the access map:
//
//   table  read    GetItem, BatchGetItem, Query, ConditionCheckItem on the table and its GSIs
//          append  PutItem on the table (append-only logs: the connector writes with attribute_not_exists)
//          write   read + PutItem, UpdateItem, DeleteItem, BatchWriteItem
//   bucket read    GetObject on its objects         append  PutObject
//          write   GetObject, PutObject, DeleteObject
//
// No table-level or bucket-level action is ever granted. Transactions need no action of their own:
// DynamoDB authorizes each item of a TransactWriteItems with its PutItem/UpdateItem/DeleteItem/
// ConditionCheckItem. The tables of the mocks (`Network`, `Dispatch`) go to infra/mocks.ts, fenced by
// `dynamodb:LeadingKeys` for every role that holds WORLDS.

import { WORLDS_LEADING_KEYS, expectedData, type Access, type BucketName, type Grant, type LambdaName, type TableName } from "./iam-capabilities";
import { MOCK_TABLES, TABLE_INDEXES } from "./storage-keys";

export const ACCESS_LEVELS = ["read", "append", "write"] as const satisfies readonly Access[];

const READ_ITEMS = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"] as const;

export const TABLE_ACTIONS: Readonly<Record<Access, readonly string[]>> = {
  read: READ_ITEMS,
  append: ["dynamodb:PutItem"],
  write: [...READ_ITEMS, "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
};

export const OBJECT_ACTIONS: Readonly<Record<Access, readonly string[]>> = {
  read: ["s3:GetObject"],
  append: ["s3:PutObject"],
  write: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
};

export interface DataAccessGrants {
  /** Tables and buckets of infra/storage.ts, resolved there with `storageResource`. */
  readonly storage: Grant[];
  /** Tables of the mocks, resolved by infra/mocks.ts. */
  readonly mocks: Grant[];
}

const isMockTable = (name: TableName): boolean => (MOCK_TABLES as readonly string[]).includes(name);

function withAccess<N extends string>(data: Readonly<Partial<Record<N, Access>>>, access: Access): N[] {
  return (Object.entries(data) as Array<[N, Access]>)
    .filter(([, level]) => level === access)
    .map(([name]) => name)
    .sort();
}

/** The table and, when the access can query, its GSIs. */
const tableResources = (name: TableName, access: Access): string[] => (access === "append" ? [`{${name}}`] : [`{${name}}`, `{${name}}/${TABLE_INDEXES}`]);

function mockFence(fn: LambdaName): Pick<Grant, "conditions"> {
  if (!(fn in WORLDS_LEADING_KEYS)) return {};
  const values = WORLDS_LEADING_KEYS[fn as keyof typeof WORLDS_LEADING_KEYS];
  return { conditions: [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values }] };
}

/** One statement per access level: tables (and their GSIs) first, then bucket objects. */
export function dataAccessGrants(fn: LambdaName): DataAccessGrants {
  const tables = expectedData(fn, "tables");
  const buckets = expectedData(fn, "buckets");
  const storage: Grant[] = [];
  const mocks: Grant[] = [];
  for (const access of ACCESS_LEVELS) {
    const names = withAccess<TableName>(tables, access);
    const own = names.filter((name) => !isMockTable(name));
    const mock = names.filter(isMockTable);
    if (own.length > 0) storage.push({ actions: TABLE_ACTIONS[access], resources: own.flatMap((name) => tableResources(name, access)) });
    if (mock.length > 0) mocks.push({ actions: TABLE_ACTIONS[access], resources: mock.flatMap((name) => tableResources(name, access)), ...mockFence(fn) });
  }
  for (const access of ACCESS_LEVELS) {
    const names = withAccess<BucketName>(buckets, access);
    if (names.length > 0) storage.push({ actions: OBJECT_ACTIONS[access], resources: names.map((name) => `{${name}}/*`) });
  }
  return { storage, mocks };
}

/** Every data action a Lambda receives, sorted (iam-capabilities.test.ts compares it). */
export function dataActions(fn: LambdaName): string[] {
  const { storage, mocks } = dataAccessGrants(fn);
  return [...new Set([...storage, ...mocks].flatMap((grant) => grant.actions))].sort();
}

/** What a linked table or bucket hands the Lambda: its name, and no permission at all. */
export function nameOnly(component: { readonly name: unknown }): { properties: { name: unknown } } {
  return { properties: { name: component.name } };
}

/** Strips SST's default `dynamodb:*` / `s3:*` from every linked Dynamo and Bucket; sst.config.ts calls it first. */
export function linkNameOnly(): void {
  sst.Linkable.wrap(sst.aws.Dynamo, nameOnly);
  sst.Linkable.wrap(sst.aws.Bucket, nameOnly);
}
