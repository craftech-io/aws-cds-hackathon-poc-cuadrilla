// DynamoDB tables: one per aggregate, keys, GSIs and TTL exactly as docs/architecture.md §5 (the spec
// lives in storage-keys.ts, checked by storage-keys.test.ts). The tables of the external mocks
// (`Network`, `Dispatch`) belong to infra/mocks.ts (WP-24). Imported by infra/storage.ts, which is
// what the rest of infra/ uses.
//
//   - On-demand billing and no stream: nothing bills while idle, and every reaction to a change goes
//     through the installer queue or a timer (docs/architecture.md §7-§8), never a table stream.
//   - Encryption at rest with the AWS managed key (`aws/dynamodb`); point-in-time recovery stays on
//     (SST's default). No deletion protection: the stage is removable (`removal: "remove"`).
//   - Physical names are SST's (`<app>-<stage>-<Name>Table-<random>`), inside the `table/<app>-*`
//     fence of the CI deploy role; code reads them from the link (`tableName("WorkOrders")`,
//     packages/bff/src/lib/resource.ts), never from `process.env`.
//
// Verify (docs/build-plan.md WP-06; `qa` compares with §5 after the deploy):
//   aws --profile craftech-demos dynamodb describe-table --table-name <physical name>
//     → KeySchema PK/SK, GlobalSecondaryIndexes, SSEDescription.Status ENABLED
//   aws --profile craftech-demos dynamodb describe-time-to-live --table-name <physical name>
//     → AttributeName expiresAt, ENABLED (every table but Reference)
//   `npx sst shell --stage poc -- env | grep SST_RESOURCE_` prints the physical names.

import { PRIMARY_KEY, TABLE_SPECS, TTL_ATTRIBUTE, tableFields, type StorageTable, type TableSpec } from "./storage-keys";

function table(name: StorageTable): sst.aws.Dynamo {
  const spec: TableSpec = TABLE_SPECS[name];
  return new sst.aws.Dynamo(name, {
    fields: tableFields(spec),
    primaryIndex: PRIMARY_KEY,
    globalIndexes: spec.indexes,
    ttl: spec.ttl ? TTL_ATTRIBUTE : undefined,
    transform: {
      table: (args) => {
        args.serverSideEncryption = { enabled: true };
      },
    },
  });
}

export const Isps = table("Isps");
export const People = table("People");
export const WorkOrders = table("WorkOrders");
export const Cases = table("Cases");
export const Conversations = table("Conversations");
export const AuditLog = table("AuditLog");
export const Reference = table("Reference");
export const Runtime = table("Runtime");
export const CuadrillaMetrics = table("CuadrillaMetrics");

/** Every table of this module, by logical name (the same name `Resource.<Name>` exposes). */
export const tables = {
  Isps,
  People,
  WorkOrders,
  Cases,
  Conversations,
  AuditLog,
  Reference,
  Runtime,
  CuadrillaMetrics,
} as const satisfies Record<StorageTable, sst.aws.Dynamo>;
