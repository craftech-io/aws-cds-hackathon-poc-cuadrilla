// Storage of the app (docs/build-plan.md WP-06): DynamoDB tables and S3 buckets of
// docs/architecture.md §5-§6. This module only aggregates; each concern lives in its own file:
//
//   storage-keys.ts      keys, GSIs, TTL, layout, retention, CORS and fences as plain data (tested)
//   storage-tables.ts    one table per aggregate (the mocks' tables are infra/mocks.ts, WP-24)
//   storage-buckets.ts   Media, Evidence, Manual, Seed
//
// The Knowledge Base over `Manual/manual/` and the Transcribe vocabulary in `Seed/transcribe/` are
// infra/storage-kb.ts and infra/media.ts (WP-21), which import the buckets from here.
//
// A Lambda links what it needs and reads `Resource.<Name>.name` (through `readLinked`), never
// `process.env`. `storageLinks(fn)` returns exactly the tables and buckets infra/iam-capabilities.ts
// declares as data access of a function, so a module never picks them by hand; the mocks' tables it
// lists in `storageFor(fn).mockTables` come from infra/mocks.ts. A link grants nothing
// (`linkNameOnly`, infra/storage-access.ts): the module passes `storagePermissions(fn)` as the
// Function's `permissions`, the exact actions of each declared access level. A table or bucket a role
// reaches only through a fenced grant (`{Runtime}` with `dynamodb:LeadingKeys`, `{Evidence}/photos/*`,
// `{Media.name}` in a condition) is resolved with `storageResource`.

import type { LambdaName } from "./iam-capabilities";
import { dataAccessGrants } from "./storage-access";
import { buckets } from "./storage-buckets";
import { parseStorageRef, storageFor, TABLE_INDEXES } from "./storage-keys";
import { tables } from "./storage-tables";

export { AuditLog, Cases, Conversations, CuadrillaMetrics, Isps, People, Reference, Runtime, WorkOrders, tables } from "./storage-tables";
export { buckets, evidenceBucket, manualBucket, mediaBucket, seedBucket } from "./storage-buckets";
export { MANUAL_PREFIX, MEDIA_TRANSCRIPTS_PREFIX, storageFor } from "./storage-keys";

/** Tables and buckets of this module a function links, as iam-capabilities.ts declares them. */
export function storageLinks(fn: LambdaName): Array<sst.aws.Dynamo | sst.aws.Bucket> {
  const needs = storageFor(fn);
  return [...needs.tables.map((name) => tables[name]), ...needs.buckets.map((name) => buckets[name])];
}

/**
 * The ARN (or the bucket name, for `{Bucket.name}`) a storage placeholder of an iam-capabilities.ts
 * grant stands for; `undefined` when the resource is not a placeholder of this module.
 */
export function storageResource(resource: string): $util.Output<string> | undefined {
  const ref = parseStorageRef(resource);
  if (ref === undefined) return undefined;
  switch (ref.kind) {
    case "table":
      return ref.indexes ? $interpolate`${tables[ref.name].arn}/${TABLE_INDEXES}` : tables[ref.name].arn;
    case "bucket-name":
      return buckets[ref.name].name;
    case "bucket":
      return ref.objects === undefined ? buckets[ref.name].arn : $interpolate`${buckets[ref.name].arn}/${ref.objects}`;
  }
}

/**
 * The statements of a function's data access (infra/storage-access.ts), for its `permissions`: item
 * actions on its tables and their GSIs, object actions on its buckets, nothing on the tables or
 * buckets themselves. The mocks' tables are infra/mocks.ts's.
 */
export function storagePermissions(fn: LambdaName): Array<{ actions: string[]; resources: $util.Output<string>[] }> {
  return dataAccessGrants(fn).storage.map((grant) => ({
    actions: [...grant.actions],
    resources: grant.resources.map((resource) => {
      const resolved = storageResource(resource);
      if (resolved === undefined) throw new Error(`${fn}: data access "${resource}" is not storage of infra/storage.ts.`);
      return resolved;
    }),
  }));
}
