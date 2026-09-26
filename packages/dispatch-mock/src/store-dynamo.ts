// DynamoDB adapter of the storage port, over the mock's own `Dispatch` table. One Query reads an
// order and its events (they share the partition); one TransactWriteItems moves the order under a
// version condition and appends the event under `attribute_not_exists`, so a lost race writes nothing.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { DISPATCH_EVENT_SK_PREFIX, DISPATCH_META_SK, DispatchEventItem, DispatchOrderItem, dispatchOrderPk } from "./items";
import { DispatchConflictError, type DispatchStore } from "./store";

// DynamoDB answers in milliseconds: past two seconds an attempt is an outage. The SDK retries
// throttling and 5xx with exponential backoff and jitter within `maxAttempts`.
export const DYNAMO_TIMEOUTS = { requestTimeoutMs: 2_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;

export function createDispatchDocumentClient(): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    maxAttempts: DYNAMO_TIMEOUTS.maxAttempts,
    requestHandler: { requestTimeout: DYNAMO_TIMEOUTS.requestTimeoutMs, connectionTimeout: DYNAMO_TIMEOUTS.connectionTimeoutMs },
  });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

/** What the adapter needs from the DocumentClient; tests pass a fake. */
export interface DocumentSender {
  send(command: QueryCommand | TransactWriteCommand): Promise<unknown>;
}

// Upper bound of pages per order: an order has one META row and a handful of events.
const MAX_PAGES = 20;

export function dynamoDispatchStore(client: DocumentSender, tableName: string): DispatchStore {
  return {
    async load(ispId, workOrderNumber) {
      const pk = dispatchOrderPk(ispId, workOrderNumber);
      const items: Record<string, unknown>[] = [];
      let startKey: Record<string, unknown> | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const output = (await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": pk },
            ConsistentRead: true,
            ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
          }),
        )) as Pick<QueryCommandOutput, "Items" | "LastEvaluatedKey">;
        items.push(...(output.Items ?? []));
        startKey = output.LastEvaluatedKey;
        if (startKey === undefined) break;
      }
      const meta = items.find((item) => item.SK === DISPATCH_META_SK);
      if (meta === undefined) return undefined;
      const events = items
        .filter((item) => typeof item.SK === "string" && item.SK.startsWith(DISPATCH_EVENT_SK_PREFIX))
        .map((item) => DispatchEventItem.parse(item))
        .sort((a, b) => (a.SK < b.SK ? -1 : 1));
      return { order: DispatchOrderItem.parse(meta), events };
    },

    async commit(order, change, event) {
      const row = DispatchEventItem.parse(event);
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: tableName,
                  Key: { PK: order.PK, SK: DISPATCH_META_SK },
                  UpdateExpression:
                    "SET #status = :status, installerId = :installerId, appointmentWindow = :window, lastEventId = :eventId, updatedAt = :updatedAt, #version = :next",
                  ConditionExpression: "#version = :expected",
                  ExpressionAttributeNames: { "#status": "status", "#version": "version" },
                  ExpressionAttributeValues: {
                    ":status": change.status,
                    ":installerId": change.installerId,
                    ":window": change.appointmentWindow,
                    ":eventId": change.lastEventId,
                    ":updatedAt": change.updatedAt,
                    ":expected": order.version,
                    ":next": order.version + 1,
                  },
                },
              },
              { Put: { TableName: tableName, Item: row, ConditionExpression: "attribute_not_exists(PK)" } },
            ],
          }),
        );
      } catch (error) {
        if (isConditionFailure(error)) throw new DispatchConflictError("the order changed or the event exists", { cause: error });
        throw error;
      }
    },
  };
}

// A transaction whose condition failed is cancelled with `ConditionalCheckFailed` among its reasons;
// any other cancellation (throttling, a conflicting transaction) is transient and propagates.
function isConditionFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return false;
  const reasons = (error as { CancellationReasons?: ReadonlyArray<{ Code?: string }> }).CancellationReasons ?? [];
  return reasons.some((reason) => reason.Code === "ConditionalCheckFailed");
}
