// `Runtime` in DynamoDB for the cap counters and the kill switch (docs/architecture.md §5: `PK` +
// `SK = META`, TTL `expiresAt` in epoch seconds). A reservation is one `TransactWriteItems` of
// conditional `ADD`s, so the counters of a spend move together or not at all; the switch is written
// with `PutItem`, the only write `CostGuard`'s role has (`dynamodb:LeadingKeys = KILL#*`). Reads are
// strongly consistent. Timeouts come from lib/clients.ts; throttling and transaction conflicts are
// retried with backoff (lib/retry.ts), a timed-out reservation only when it carries an idempotency
// token (DynamoDB then applies it at most once).
import { createHash } from "node:crypto";
import { BatchGetCommand, type DynamoDBDocumentClient, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConnectorError } from "@cuadrilla/shared";
import { dynamoDocumentClient } from "../lib/clients";
import { tableName } from "../lib/resource";
import { type RetryOptions, withRetry } from "../lib/retry";
import type { CapCounter, CapLedgerStore, CapStoreReserveResult } from "./cost-caps";
import type { KillSwitchRecord, KillSwitchStore } from "./kill-switch";

const TABLE = "Runtime";
const META = "META";
const BATCH_GET_ROUNDS = 4;

export interface DynamoRuntimeStoreOptions {
  readonly client?: DynamoDBDocumentClient;
  /** Physical name of `Runtime`; by default the SST link (`Resource.Runtime.name`). */
  readonly table?: () => string;
  /** Injected for tests. */
  readonly retry?: Pick<RetryOptions, "sleep" | "random" | "attempts">;
}

const THROTTLED = new Set(["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded", "TransactionConflictException", "TransactionInProgressException"]);
const UNAVAILABLE = new Set(["InternalServerError", "ServiceUnavailable", "TimeoutError", "RequestTimeout", "NetworkingError"]);

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export function toConnectorError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const name = errorName(error);
  if (name === "IdempotentParameterMismatchException") return new ConnectorError("CONFLICT", "idempotency key reused with other counters", TABLE, { cause: error });
  if (THROTTLED.has(name)) return new ConnectorError("THROTTLED", `${TABLE} throttled (${name})`, TABLE, { cause: error });
  if (UNAVAILABLE.has(name)) return new ConnectorError("TIMEOUT", `${TABLE} did not answer (${name})`, TABLE, { cause: error });
  if (name === "ValidationException") return new ConnectorError("VALIDATION", `${TABLE} rejected the request`, TABLE, { cause: error });
  return new ConnectorError("UNAVAILABLE", `${TABLE} failed (${name})`, TABLE, { cause: error });
}

/** Client request token of a reservation: at most 36 characters, stable for the same key. */
export function clientRequestToken(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 32);
}

interface CancellationReason {
  readonly Code?: string;
  readonly Item?: Record<string, unknown>;
}

// With the document client the cancellation reasons still carry raw attribute values.
function usedFrom(item: Record<string, unknown> | undefined): number | undefined {
  const used = item?.used;
  if (typeof used === "number") return used;
  if (typeof used === "object" && used !== null && typeof Reflect.get(used, "N") === "string") return Number(Reflect.get(used, "N"));
  return undefined;
}

/**
 * A counter that is only checked (`amount` 0, the simulator before it enqueues) is a ConditionCheck:
 * the check writes nothing, so a role fenced away from a counter's key (the QaDriver and the stage's
 * ceiling) can still read whether it has room.
 */
function checkItem(table: string, counter: CapCounter) {
  return {
    ConditionCheck: {
      TableName: table,
      Key: { PK: counter.key, SK: META },
      ConditionExpression: "attribute_not_exists(#used) OR #used <= :max",
      ExpressionAttributeNames: { "#used": "used" },
      ExpressionAttributeValues: { ":max": counter.limit - 1 },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
    },
  };
}

function reserveItem(table: string, counter: CapCounter, nowIso: string) {
  if (counter.amount === 0) return checkItem(table, counter);
  return {
    Update: {
      TableName: table,
      Key: { PK: counter.key, SK: META },
      UpdateExpression:
        "ADD #used :amount SET #entity = :entity, #ledger = :ledger, #resource = :resource, #period = :period, #capLimit = :limit, #expiresAt = if_not_exists(#expiresAt, :expiresAt), #createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now",
      ConditionExpression: "attribute_not_exists(#used) OR #used <= :max",
      ExpressionAttributeNames: {
        "#used": "used",
        "#entity": "entity",
        "#ledger": "ledger",
        "#resource": "resource",
        "#period": "period",
        "#capLimit": "capLimit",
        "#expiresAt": "expiresAt",
        "#createdAt": "createdAt",
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":amount": counter.amount,
        ":entity": "CapCounter",
        ":ledger": counter.ledger,
        ":resource": counter.resource,
        ":period": counter.period,
        ":limit": counter.limit,
        ":expiresAt": counter.expiresAt,
        ":now": nowIso,
        ":max": counter.limit - Math.max(counter.amount, 1),
      },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
    },
  };
}

export function createDynamoRuntimeStore(options: DynamoRuntimeStoreOptions = {}): CapLedgerStore & KillSwitchStore {
  const client = (): DynamoDBDocumentClient => options.client ?? dynamoDocumentClient();
  const table = options.table ?? (() => tableName("Runtime"));
  const retryable = (error: unknown): boolean => error instanceof ConnectorError && error.code === "THROTTLED";

  async function batchGet(keys: readonly string[], projection?: string): Promise<Map<string, Record<string, unknown>>> {
    const found = new Map<string, Record<string, unknown>>();
    const name = table();
    let pending: Array<Record<string, string>> = keys.map((key) => ({ PK: key, SK: META }));
    for (let round = 0; pending.length > 0; round += 1) {
      if (round === BATCH_GET_ROUNDS) throw new ConnectorError("THROTTLED", `${TABLE} left keys unprocessed`, TABLE);
      const request = pending;
      const output = await withRetry(
        async () => {
          try {
            return await client().send(new BatchGetCommand({ RequestItems: { [name]: { Keys: request, ConsistentRead: true, ...(projection === undefined ? {} : { ProjectionExpression: projection, ExpressionAttributeNames: { "#used": "used" } }) } } }));
          } catch (error) {
            throw toConnectorError(error);
          }
        },
        { ...options.retry, shouldRetry: (error) => error instanceof ConnectorError && error.retryable },
      );
      for (const item of output.Responses?.[name] ?? []) if (typeof item.PK === "string") found.set(item.PK, item);
      pending = (output.UnprocessedKeys?.[name]?.Keys ?? []) as Array<Record<string, string>>;
    }
    return found;
  }

  return {
    async reserve(counters, { idempotencyKey, nowIso }): Promise<CapStoreReserveResult> {
      const impossible = counters.find((counter) => counter.limit < Math.max(counter.amount, 1));
      if (impossible !== undefined) return { ok: false, failedKey: impossible.key };
      const name = table();
      const command = new TransactWriteCommand({
        TransactItems: counters.map((counter) => reserveItem(name, counter, nowIso)),
        ...(idempotencyKey === undefined ? {} : { ClientRequestToken: clientRequestToken(idempotencyKey) }),
      });
      try {
        await withRetry(
          async () => {
            try {
              return await client().send(command);
            } catch (error) {
              if (errorName(error) === "TransactionCanceledException") {
                const reasons = (Reflect.get(error as object, "CancellationReasons") ?? []) as CancellationReason[];
                const failed = reasons.findIndex((reason) => reason.Code === "ConditionalCheckFailed");
                if (failed !== -1) throw Object.assign(new Error("cap reached"), { name: "CapReached", index: failed, used: usedFrom(reasons[failed]?.Item) });
                throw new ConnectorError("THROTTLED", `${TABLE} transaction cancelled`, TABLE, { cause: error });
              }
              throw toConnectorError(error);
            }
          },
          { ...options.retry, shouldRetry: (error) => retryable(error) || (idempotencyKey !== undefined && error instanceof ConnectorError && error.code === "TIMEOUT") },
        );
      } catch (error) {
        if (errorName(error) !== "CapReached") throw error;
        const index = Number(Reflect.get(error as object, "index"));
        const used = Reflect.get(error as object, "used") as number | undefined;
        const counter = counters[index] ?? counters[0];
        if (counter === undefined) throw error;
        return used === undefined ? { ok: false, failedKey: counter.key } : { ok: false, failedKey: counter.key, used };
      }
      return { ok: true };
    },

    async release(counters) {
      const name = table();
      for (const counter of counters) {
        try {
          await client().send(
            new UpdateCommand({
              TableName: name,
              Key: { PK: counter.key, SK: META },
              UpdateExpression: "ADD #used :negative",
              ConditionExpression: "#used >= :amount",
              ExpressionAttributeNames: { "#used": "used" },
              ExpressionAttributeValues: { ":negative": -counter.amount, ":amount": counter.amount },
            }),
          );
        } catch (error) {
          // A counter that expired or was already given back stays as it is.
          if (errorName(error) !== "ConditionalCheckFailedException") throw toConnectorError(error);
        }
      }
    },

    async readUsed(keys) {
      const items = await batchGet(keys, "PK, #used");
      return new Map([...items].map(([key, item]) => [key, usedFrom(item) ?? 0] as const));
    },

    async read(keys) {
      const items = await batchGet(keys);
      return new Map([...items].map(([key, { PK: _pk, SK: _sk, ...item }]) => [key, item] as const));
    },

    async write(key: string, record: KillSwitchRecord, expiresAt?: number) {
      const item = { PK: key, SK: META, entity: "KillSwitch", ...record, updatedAt: record.setAtReal, ...(expiresAt === undefined ? {} : { expiresAt }) };
      await withRetry(
        async () => {
          try {
            return await client().send(new PutCommand({ TableName: table(), Item: item }));
          } catch (error) {
            throw toConnectorError(error);
          }
        },
        { ...options.retry, shouldRetry: retryable },
      );
    },
  };
}
