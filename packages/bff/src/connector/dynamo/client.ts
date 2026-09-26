/// <reference path="../../../sst-env.d.ts" />
// TableClient over DynamoDB DocumentClient. Physical table names come from the SST link
// (`Resource.<Table>.name` through lib/resource.ts, never `process.env`); every call carries the SDK
// timeout of lib/clients.ts, and throttling is retried with backoff on top of the SDK's own attempts
// (reads also on timeout: they are idempotent). SDK failures become typed `ConnectorError`s.
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ConnectorError } from "@cuadrilla/shared";
import { tableName } from "../../lib/resource";
import { backoffDelayMs, withRetry } from "../../lib/retry";
import { TRANSACT_MAX_OPS, isExistenceOnly, type IncrementOptions, type Item, type Key, type Patch, type QuerySpec, type SetUpdateOptions, type Table, type TableClient, type TransactOp, type WriteCondition } from "../table-client";
import { condition, incrementExpression, keyCondition, omitEmpty, setExpression, updateExpression, type UpdateExpression } from "./expressions";

const BATCH_WRITE_MAX = 25;
const BATCH_WRITE_ROUNDS = 5;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function cancellationCodes(error: unknown): string[] {
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  return reasons.map((reason) => reason.Code ?? "None");
}

// Maps SDK failures to the typed connector error; unknown errors become UNAVAILABLE so the tool
// envelope never leaks SDK internals to the model.
export function toConnectorError(error: unknown, table: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const options = { cause: error };
  switch (errorName(error)) {
    case "ConditionalCheckFailedException":
      return new ConnectorError("CONFLICT", `condition failed on ${table}`, table, options);
    case "TransactionCanceledException": {
      const codes = cancellationCodes(error);
      if (codes.includes("ConditionalCheckFailed")) return new ConnectorError("CONFLICT", `transaction condition failed on ${table}`, table, options);
      if (codes.some((code) => code === "TransactionConflict" || code === "ThrottlingError" || code === "ProvisionedThroughputExceeded")) {
        return new ConnectorError("THROTTLED", `transaction contention on ${table}`, table, options);
      }
      return new ConnectorError("CONFLICT", `transaction cancelled on ${table}`, table, options);
    }
    case "TransactionConflictException":
    case "ProvisionedThroughputExceededException":
    case "ThrottlingException":
    case "RequestLimitExceeded":
      return new ConnectorError("THROTTLED", `throttled on ${table}`, table, options);
    case "TimeoutError":
    case "AbortError":
    case "RequestTimeout":
      return new ConnectorError("TIMEOUT", `timeout on ${table}`, table, options);
    case "ValidationException":
      return new ConnectorError("VALIDATION", `invalid request on ${table}`, table, options);
    case "ResourceNotFoundException":
      return new ConnectorError("UNAVAILABLE", `table ${table} not found`, table, options);
    default:
      return new ConnectorError("UNAVAILABLE", `dynamodb failure on ${table}`, table, options);
  }
}

function isItem(value: Record<string, unknown> | undefined): value is Item {
  return value !== undefined && typeof value.PK === "string" && typeof value.SK === "string";
}

function updateInput(name: string, key: Key, built: UpdateExpression) {
  return {
    TableName: name,
    Key: key,
    UpdateExpression: built.expression,
    ConditionExpression: built.conditionExpression,
    ExpressionAttributeNames: omitEmpty(built.names),
    ExpressionAttributeValues: omitEmpty(built.values),
  };
}

function conditionInput(cond: WriteCondition | undefined) {
  const built = condition(cond);
  return { ConditionExpression: built.expression, ExpressionAttributeNames: omitEmpty(built.names), ExpressionAttributeValues: omitEmpty(built.values) };
}

export interface DynamoTableClientOptions {
  /** Physical name resolver; defaults to the SST link. Tests inject a map. */
  readonly resolveName?: (table: Table) => string;
  /** Injected for tests (retry backoff). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class DynamoTableClient implements TableClient {
  private readonly resolveName: (table: Table) => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    options: DynamoTableClientOptions = {},
  ) {
    this.resolveName = options.resolveName ?? tableName;
    this.sleep = options.sleep ?? realSleep;
  }

  private async run<T>(table: Table, operation: () => Promise<T>, idempotent = false): Promise<T> {
    return withRetry(
      async () => {
        try {
          return await operation();
        } catch (error) {
          throw toConnectorError(error, table);
        }
      },
      {
        shouldRetry: (error) => error instanceof ConnectorError && (error.code === "THROTTLED" || (idempotent && error.code === "TIMEOUT")),
        sleep: this.sleep,
      },
    );
  }

  async get(table: Table, key: Key): Promise<Item | undefined> {
    const output = await this.run(table, () => this.client.send(new GetCommand({ TableName: this.resolveName(table), Key: key, ConsistentRead: true })), true);
    return isItem(output.Item) ? output.Item : undefined;
  }

  async query(table: Table, spec: QuerySpec): Promise<Item[]> {
    const built = keyCondition(table, spec);
    const items: Item[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const remaining = spec.limit === undefined ? undefined : spec.limit - items.length;
      const output = await this.run(
        table,
        () =>
          this.client.send(
            new QueryCommand({
              TableName: this.resolveName(table),
              IndexName: built.indexName,
              KeyConditionExpression: built.expression,
              ExpressionAttributeNames: built.names,
              ExpressionAttributeValues: built.values,
              ScanIndexForward: !spec.descending,
              Limit: remaining,
              ExclusiveStartKey: startKey,
              // GSIs only support eventually consistent reads.
              ConsistentRead: built.indexName === undefined,
            }),
          ),
        true,
      );
      for (const row of output.Items ?? []) if (isItem(row)) items.push(row);
      startKey = output.LastEvaluatedKey;
    } while (startKey !== undefined && (spec.limit === undefined || items.length < spec.limit));
    return items;
  }

  async put(table: Table, item: Item, cond?: WriteCondition): Promise<void> {
    await this.run(table, () => this.client.send(new PutCommand({ TableName: this.resolveName(table), Item: item, ...conditionInput(cond) })));
  }

  async update(table: Table, key: Key, patch: Patch, updatedAt: string, cond?: WriteCondition): Promise<Item> {
    const built = updateExpression(patch, updatedAt, { ifExists: true, ...cond });
    try {
      const output = await this.run(table, () => this.client.send(new UpdateCommand({ ...updateInput(this.resolveName(table), key, built), ReturnValues: "ALL_NEW" })));
      if (!isItem(output.Attributes)) throw new ConnectorError("UNAVAILABLE", `update on ${table} returned no item`, table);
      return output.Attributes;
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "CONFLICT" && isExistenceOnly(cond)) {
        throw new ConnectorError("NOT_FOUND", `${table} item ${key.PK}/${key.SK} not found`, table, { cause: error });
      }
      throw error;
    }
  }

  async delete(table: Table, key: Key, cond?: WriteCondition): Promise<void> {
    await this.run(table, () => this.client.send(new DeleteCommand({ TableName: this.resolveName(table), Key: key, ...conditionInput(cond) })));
  }

  async increment(table: Table, key: Key, attribute: string, by: number, options: IncrementOptions): Promise<number> {
    const built = incrementExpression(attribute, by, options.updatedAt, options.max, options.defaults);
    const output = await this.run(table, () => this.client.send(new UpdateCommand({ ...updateInput(this.resolveName(table), key, built), ReturnValues: "ALL_NEW" })));
    const value = output.Attributes?.[attribute];
    if (typeof value !== "number") throw new ConnectorError("UNAVAILABLE", `counter ${attribute} on ${table} is not numeric`, table);
    return value;
  }

  async addToSet(table: Table, key: Key, attribute: string, values: readonly string[], options: SetUpdateOptions): Promise<Item> {
    const built = setExpression("ADD", attribute, values, options.updatedAt, options.defaults, options.condition);
    const output = await this.run(table, () => this.client.send(new UpdateCommand({ ...updateInput(this.resolveName(table), key, built), ReturnValues: "ALL_NEW" })));
    if (!isItem(output.Attributes)) throw new ConnectorError("UNAVAILABLE", `set update on ${table} returned no item`, table);
    return output.Attributes;
  }

  async removeFromSet(table: Table, key: Key, attribute: string, values: readonly string[], options: SetUpdateOptions): Promise<Item | undefined> {
    const built = setExpression("DELETE", attribute, values, options.updatedAt, undefined, { ifExists: true, ...options.condition });
    try {
      const output = await this.run(table, () => this.client.send(new UpdateCommand({ ...updateInput(this.resolveName(table), key, built), ReturnValues: "ALL_NEW" })));
      return isItem(output.Attributes) ? output.Attributes : undefined;
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "CONFLICT" && isExistenceOnly(options.condition)) return undefined;
      throw error;
    }
  }

  private toTransactItem(op: TransactOp, updatedAt: string): TransactItem {
    const name = this.resolveName(op.table);
    switch (op.op) {
      case "put":
        return { Put: { TableName: name, Item: op.item, ...conditionInput(op.condition) } };
      case "update":
        return { Update: updateInput(name, op.key, updateExpression(op.patch, updatedAt, { ifExists: true, ...op.condition })) };
      case "delete":
        return { Delete: { TableName: name, Key: op.key, ...conditionInput(op.condition) } };
      case "increment":
        return { Update: updateInput(name, op.key, incrementExpression(op.attribute, op.by, updatedAt, op.max, op.defaults)) };
      case "addToSet":
        return { Update: updateInput(name, op.key, setExpression("ADD", op.attribute, op.values, updatedAt, op.defaults, undefined)) };
    }
  }

  async transact(ops: readonly TransactOp[], updatedAt: string): Promise<void> {
    if (ops.length === 0) return;
    if (ops.length > TRANSACT_MAX_OPS) throw new ConnectorError("VALIDATION", `a transaction takes at most ${TRANSACT_MAX_OPS} operations`);
    const first = ops[0]?.table ?? "Runtime";
    await this.run(first, () => this.client.send(new TransactWriteCommand({ TransactItems: ops.map((op) => this.toTransactItem(op, updatedAt)) })));
  }

  private async batchWrite(table: Table, requests: ReadonlyArray<Record<string, unknown>>, describe: string): Promise<void> {
    const name = this.resolveName(table);
    for (let offset = 0; offset < requests.length; offset += BATCH_WRITE_MAX) {
      let pending = requests.slice(offset, offset + BATCH_WRITE_MAX);
      for (let round = 0; pending.length > 0; round += 1) {
        if (round >= BATCH_WRITE_ROUNDS) throw new ConnectorError("THROTTLED", `batch ${describe} on ${table} left ${pending.length} unprocessed items`, table);
        const batch = pending;
        const output = await this.run(table, () => this.client.send(new BatchWriteCommand({ RequestItems: { [name]: [...batch] } })));
        pending = output.UnprocessedItems?.[name] ?? [];
        if (pending.length > 0) await this.sleep(backoffDelayMs(round + 1));
      }
    }
  }

  async batchPut(table: Table, items: readonly Item[]): Promise<void> {
    await this.batchWrite(table, items.map((item) => ({ PutRequest: { Item: item } })), "put");
  }

  async batchDelete(table: Table, keys: readonly Key[]): Promise<void> {
    await this.batchWrite(table, keys.map((key) => ({ DeleteRequest: { Key: { PK: key.PK, SK: key.SK } } })), "delete");
  }
}
