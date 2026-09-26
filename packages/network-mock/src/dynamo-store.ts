/// <reference path="../../../sst-env.d.ts" />
// DynamoDB adapter of `OnuStore` over the mock's own table, `Network` (the only one its role can
// touch). A read is one `UpdateItem` that only adds to counters and returns the row, so reads can
// never change a behaviour or race a world event; a world event is a conditional write on `version`.
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { NetworkReader } from "@cuadrilla/network-contract";
import { Resource } from "sst";
import { z } from "zod";
import type { OnuStatePatch } from "./behaviours";
import { OnuRow, READER_COUNTER, type OnuKey } from "./rows";
import type { OnuStore } from "./store";

/** What the adapter needs from the DocumentClient; tests pass a fake. */
export interface DocumentSender {
  send(command: GetCommand | UpdateCommand): Promise<{ Item?: Record<string, unknown>; Attributes?: Record<string, unknown> }>;
}

function isConditionFailure(error: unknown): boolean {
  return error instanceof ConditionalCheckFailedException || (error instanceof Error && error.name === "ConditionalCheckFailedException");
}

function row(value: Record<string, unknown> | undefined): OnuRow | undefined {
  return value === undefined ? undefined : OnuRow.parse(value);
}

export class DynamoOnuStore implements OnuStore {
  constructor(
    private readonly client: DocumentSender,
    private readonly tableName: string,
  ) {}

  async get(key: OnuKey): Promise<OnuRow | undefined> {
    const out = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { ...key }, ConsistentRead: true }));
    return row(out.Item);
  }

  async countRead(key: OnuKey, reader: NetworkReader | undefined): Promise<OnuRow | undefined> {
    const byReader = reader === undefined ? "" : ", #reader :one";
    try {
      const out = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { ...key },
          UpdateExpression: `ADD queryCount :one${byReader}`,
          ConditionExpression: "attribute_exists(PK)",
          ...(reader === undefined ? {} : { ExpressionAttributeNames: { "#reader": READER_COUNTER[reader] } }),
          ExpressionAttributeValues: { ":one": 1 },
          ReturnValues: "ALL_NEW",
        }),
      );
      return row(out.Attributes);
    } catch (error) {
      if (isConditionFailure(error)) return undefined;
      throw error;
    }
  }

  async countFault(key: OnuKey): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { ...key },
          UpdateExpression: "ADD faultCount :one",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":one": 1 },
        }),
      );
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }

  async replace(key: OnuKey, expectedVersion: number, patch: OnuStatePatch, updatedAt: string): Promise<boolean> {
    const set = ["behaviour = :behaviour", "fixed = :fixed", "updatedAt = :updatedAt", "version = :next"];
    const values: Record<string, unknown> = {
      ":behaviour": patch.behaviour,
      ":fixed": patch.fixed,
      ":updatedAt": updatedAt,
      ":next": expectedVersion + 1,
      ":expected": expectedVersion,
    };
    if (patch.rxPowerDbm !== undefined) {
      set.push("rxPowerDbm = :rx");
      values[":rx"] = patch.rxPowerDbm;
    }
    if (patch.fixed) {
      set.push("fixedBy = :fixedBy", "fixedAtSim = :fixedAtSim");
      values[":fixedBy"] = patch.fixedBy;
      values[":fixedAtSim"] = patch.fixedAtSim;
    }
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { ...key },
          UpdateExpression: `SET ${set.join(", ")}${patch.fixed ? "" : " REMOVE fixedBy, fixedAtSim"}`,
          ConditionExpression: "version = :expected",
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }
}

// DynamoDB answers in milliseconds; past two seconds it is an outage, and the SDK retries throttling.
const DYNAMO_CLIENT = { maxAttempts: 3, requestHandler: { requestTimeout: 2_000, connectionTimeout: 1_000 } } as const;

let store: DynamoOnuStore | undefined;

/** The store of the deployed mock: the `Network` table linked to its function (`Resource`, never env). */
export function networkTableStore(): DynamoOnuStore {
  if (store === undefined) {
    const table = z.object({ name: z.string().min(1) }).parse(Reflect.get(Resource, "Network"));
    const client = DynamoDBDocumentClient.from(new DynamoDBClient(DYNAMO_CLIENT), { marshallOptions: { removeUndefinedValues: true } });
    store = new DynamoOnuStore(client, table.name);
  }
  return store;
}
