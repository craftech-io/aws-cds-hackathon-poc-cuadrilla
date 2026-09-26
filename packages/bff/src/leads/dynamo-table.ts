/// <reference path="../../sst-env.d.ts" />
// `LeadTable` over DynamoDB (`Resource.Leads.name` through lib/resource.ts, never `process.env`), with
// the SDK timeouts of lib/clients.ts and backoff on throttling (and on timeouts for idempotent reads).
// Every write names only attributes of the item it writes: a pending lead carries only the attributes
// the `Bff` may write (`dynamodb:Attributes` of infra/leads-spec.ts), and the only conditions are on
// `PK` and `version`, both in that list. `ReturnValues` is never asked for.
import {
  BatchWriteCommand,
  type DynamoDBDocumentClient,
  DeleteCommand,
  type DeleteCommandInput,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ConnectorError } from "@cuadrilla/shared";
import { toConnectorError } from "../connector/dynamo/client";
import { dynamoDocumentClient } from "../lib/clients";
import { tableName } from "../lib/resource";
import { ulid } from "../lib/crypto";
import { withRetry } from "../lib/retry";
import { LEAD_EVENT_PREFIX, LEAD_META, type Lead, Lead as LeadSchema, type LeadEvent, LeadEvent as LeadEventSchema, type LeadLogEntry, leadKey, leadPartition } from "./model";
import { type LeadStore, type LeadTable, createLeadStore } from "./store";

const TABLE = "Leads";
const BATCH_WRITE_MAX = 25;
const BATCH_WRITE_ROUNDS = 5;

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

function isConditionFailure(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === "CONFLICT";
}

/** The conditional put of a lead's `META` item, for a caller that writes it inside its own transaction. */
export function leadPutTransactItem(table: string, lead: Lead, expectedVersion: number | undefined): TransactItem {
  const item = LeadSchema.parse(lead);
  return expectedVersion === undefined
    ? { Put: { TableName: table, Item: item, ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "PK" } } }
    : { Put: { TableName: table, Item: item, ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": expectedVersion } } };
}

export interface DynamoLeadTableOptions {
  readonly client?: DynamoDBDocumentClient;
  /** Physical table name; defaults to the SST link. */
  readonly table?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createDynamoLeadTable(options: DynamoLeadTableOptions = {}): LeadTable {
  const client = (): DynamoDBDocumentClient => options.client ?? dynamoDocumentClient();
  const table = options.table ?? (() => tableName(TABLE));

  async function run<T>(operation: () => Promise<T>, idempotent: boolean): Promise<T> {
    return withRetry(
      async () => {
        try {
          return await operation();
        } catch (error) {
          throw toConnectorError(error, TABLE);
        }
      },
      {
        shouldRetry: (error) => error instanceof ConnectorError && (error.code === "THROTTLED" || (idempotent && error.code === "TIMEOUT")),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      },
    );
  }

  async function conditional(operation: () => Promise<unknown>): Promise<boolean> {
    try {
      await run(operation, false);
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  async function queryAll(input: ConstructorParameters<typeof QueryCommand>[0]): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const output = await run(() => client().send(new QueryCommand({ ...input, ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }) })), true);
      items.push(...(output.Items ?? []));
      startKey = output.LastEvaluatedKey;
    } while (startKey !== undefined);
    return items;
  }

  async function batchDelete(keys: ReadonlyArray<Record<string, string>>): Promise<void> {
    for (let start = 0; start < keys.length; start += BATCH_WRITE_MAX) {
      let pending = keys.slice(start, start + BATCH_WRITE_MAX).map((Key) => ({ DeleteRequest: { Key } }));
      for (let round = 0; pending.length > 0; round += 1) {
        if (round >= BATCH_WRITE_ROUNDS) throw new ConnectorError("THROTTLED", "lead events left unprocessed", TABLE);
        const output = await run(() => client().send(new BatchWriteCommand({ RequestItems: { [table()]: pending } })), true);
        pending = (output.UnprocessedItems?.[table()] ?? []).flatMap((request) => (request.DeleteRequest?.Key ? [{ DeleteRequest: { Key: request.DeleteRequest.Key } }] : []));
      }
    }
  }

  return {
    async getMeta(emailHash) {
      const output = await run(() => client().send(new GetCommand({ TableName: table(), Key: leadKey(emailHash), ConsistentRead: true })), true);
      return output.Item === undefined ? undefined : LeadSchema.parse(output.Item);
    },

    putMeta(lead, expectedVersion) {
      const put = leadPutTransactItem(table(), lead, expectedVersion).Put;
      if (put === undefined) throw new RangeError("a lead put without its Put");
      return conditional(() => client().send(new PutCommand(put)));
    },

    deleteMeta(emailHash, expectedVersion) {
      const condition: Pick<DeleteCommandInput, "ConditionExpression" | "ExpressionAttributeNames" | "ExpressionAttributeValues"> =
        expectedVersion === undefined
          ? { ConditionExpression: "attribute_exists(#pk)", ExpressionAttributeNames: { "#pk": "PK" } }
          : { ConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": expectedVersion } };
      return conditional(() => client().send(new DeleteCommand({ TableName: table(), Key: leadKey(emailHash), ...condition })));
    },

    async queryBySubKey(subKey) {
      const items = await queryAll({ TableName: table(), IndexName: "GSI1", KeyConditionExpression: "#s = :s", ExpressionAttributeNames: { "#s": "subKey" }, ExpressionAttributeValues: { ":s": subKey } });
      return items.filter((item) => item.SK === LEAD_META).map((item) => LeadSchema.parse(item));
    },

    async putRecord(item: LeadEvent | LeadLogEntry) {
      await run(() => client().send(new PutCommand({ TableName: table(), Item: item })), false);
    },

    async listEvents(emailHash) {
      const items = await queryAll({
        TableName: table(),
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :evt)",
        ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
        ExpressionAttributeValues: { ":pk": leadPartition(emailHash), ":evt": LEAD_EVENT_PREFIX },
      });
      return items.map((item) => LeadEventSchema.parse(item));
    },

    async deleteEvents(emailHash, sortKeys) {
      await batchDelete(sortKeys.map((SK) => ({ PK: leadPartition(emailHash), SK })));
    },

    async scanMeta() {
      const leads: Lead[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const output = await run(
          () =>
            client().send(
              new ScanCommand({
                TableName: table(),
                FilterExpression: "#sk = :meta AND begins_with(#pk, :lead)",
                ExpressionAttributeNames: { "#sk": "SK", "#pk": "PK" },
                ExpressionAttributeValues: { ":meta": LEAD_META, ":lead": "LEAD#" },
                ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
              }),
            ),
          true,
        );
        leads.push(...(output.Items ?? []).map((item) => LeadSchema.parse(item)));
        startKey = output.LastEvaluatedKey;
      } while (startKey !== undefined);
      return leads;
    },
  };
}

let defaultStore: LeadStore | undefined;

/** The container's `LeadStore` over the linked `Leads` table (the Lambdas that link it). */
export function dynamoLeadStore(): LeadStore {
  defaultStore ??= createLeadStore(createDynamoLeadTable(), { newId: () => ulid() });
  return defaultStore;
}
