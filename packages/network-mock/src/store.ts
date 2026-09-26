// Port of the mock's storage and its in-memory adapter (tests and the local flows of tests/flows/).
// The DynamoDB adapter (dynamo-store.ts) keeps the same semantics: reads only add to counters, and
// every state change is conditional on the row's `version`.
import type { NetworkReader } from "@cuadrilla/network-contract";
import type { OnuStatePatch } from "./behaviours";
import { withPatch } from "./behaviours";
import { OnuRow, READER_COUNTER, type OnuKey } from "./rows";

export interface OnuStore {
  get(key: OnuKey): Promise<OnuRow | undefined>;
  /** Adds one read (and one for `reader`) and returns the row after it; `undefined` if there is no such ONU. */
  countRead(key: OnuKey, reader: NetworkReader | undefined): Promise<OnuRow | undefined>;
  /** Adds one faulted read to an existing row; nothing when the row does not exist. */
  countFault(key: OnuKey): Promise<void>;
  /** Writes the state of `patch` if the row still has `expectedVersion`; false when it changed or vanished. */
  replace(key: OnuKey, expectedVersion: number, patch: OnuStatePatch, updatedAt: string): Promise<boolean>;
}

export class InMemoryOnuStore implements OnuStore {
  private readonly rows = new Map<string, OnuRow>();

  /** Seeds or overwrites a row, as the world factory does. */
  put(row: OnuRow): void {
    const parsed = OnuRow.parse(row);
    this.rows.set(parsed.PK, parsed);
  }

  async get(key: OnuKey): Promise<OnuRow | undefined> {
    const row = this.rows.get(key.PK);
    return row === undefined ? undefined : { ...row };
  }

  async countRead(key: OnuKey, reader: NetworkReader | undefined): Promise<OnuRow | undefined> {
    const row = this.rows.get(key.PK);
    if (row === undefined) return undefined;
    const next: OnuRow = { ...row, queryCount: row.queryCount + 1 };
    if (reader !== undefined) next[READER_COUNTER[reader]] = (row[READER_COUNTER[reader]] ?? 0) + 1;
    this.rows.set(key.PK, next);
    return { ...next };
  }

  async countFault(key: OnuKey): Promise<void> {
    const row = this.rows.get(key.PK);
    if (row !== undefined) this.rows.set(key.PK, { ...row, faultCount: (row.faultCount ?? 0) + 1 });
  }

  async replace(key: OnuKey, expectedVersion: number, patch: OnuStatePatch, updatedAt: string): Promise<boolean> {
    const row = this.rows.get(key.PK);
    if (row === undefined || row.version !== expectedVersion) return false;
    this.rows.set(key.PK, OnuRow.parse({ ...withPatch(row, patch), updatedAt, version: row.version + 1 }));
    return true;
  }
}
