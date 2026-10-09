// The two simulated systems of a local world, in process (docs/test-plan.md §2, level LF):
//
//   NetworkMock   packages/network-mock's routes (`handleNetworkRequest`) over the world's own `Network`
//                 rows, behind the product's network client (network/client.ts): the same requests, the
//                 same retries and the same mapping of failures. `outage` answers 503 to every request,
//                 as the orchestrator does under the fault `ERROR_503` (FL-026).
//   DispatchMock  packages/dispatch-mock's commands over its seed rows, publishing to `FeedEvents` in
//                 process (feeds/dispatch-events.ts), which validates and queues `DISPATCH_EVENT`.
import type { NetworkReader } from "@cuadrilla/network-contract";
import { type DispatchCommand, type DispatchOrderItem, memoryDispatchStore, recordingPublisher, runCommand, toBusEvent } from "@cuadrilla/dispatch-mock";
import { OnuRow, READER_COUNTER, handleNetworkRequest, type OnuStatePatch, type OnuStore } from "@cuadrilla/network-mock";
import type { OnuKey } from "@cuadrilla/network-mock";
import { withPatch } from "@cuadrilla/network-mock/behaviours";
import type { MemoryTableClient } from "../../../packages/bff/src/connector/memory/table-client";
import { type DispatchFeedDeps, acceptDispatchEvent } from "../../../packages/bff/src/feeds/dispatch-events";
import { type NetworkClient, createNetworkClient } from "../../../packages/bff/src/network/client";
import type { HttpTransport } from "../../../packages/bff/src/network/sigv4";

/** The mock's storage over the world's `Network` table (reads only add to counters; changes are conditional). */
export function tableOnuStore(client: MemoryTableClient): OnuStore {
  const read = async (key: OnuKey): Promise<OnuRow | undefined> => {
    const item = await client.get("Network", { PK: key.PK, SK: key.SK });
    return item === undefined ? undefined : OnuRow.parse(item);
  };
  return {
    get: read,
    async countRead(key, reader: NetworkReader | undefined) {
      const row = await read(key);
      if (row === undefined) return undefined;
      const next: OnuRow = { ...row, queryCount: row.queryCount + 1 };
      if (reader !== undefined) next[READER_COUNTER[reader]] = (row[READER_COUNTER[reader]] ?? 0) + 1;
      await client.put("Network", { ...next });
      return next;
    },
    async countFault(key) {
      const row = await read(key);
      if (row !== undefined) await client.put("Network", { ...row, faultCount: (row.faultCount ?? 0) + 1 });
    },
    async replace(key, expectedVersion, patch: OnuStatePatch, updatedAt) {
      const row = await read(key);
      if (row === undefined || row.version !== expectedVersion) return false;
      await client.put("Network", { ...OnuRow.parse({ ...withPatch(row, patch), updatedAt, version: row.version + 1 }) });
      return true;
    },
  };
}

export interface LocalNetwork {
  readonly client: NetworkClient;
  /** Requests the orchestrator received, `METHOD path`, in order. */
  readonly requests: string[];
  /** While true, every request answers 503 with `Retry-After: 0` (FL-026). */
  outage: boolean;
  /** The ONU row of a serial in a world. */
  row(clockId: string, serial: string): Promise<OnuRow | undefined>;
}

export function localNetwork(client: MemoryTableClient, now: () => Date): LocalNetwork {
  const store = tableOnuStore(client);
  const requests: string[] = [];
  const network: LocalNetwork = {
    requests,
    outage: false,
    client: undefined as unknown as NetworkClient,
    row: (clockId, serial) => client.get("Network", { PK: `ONU#${clockId}#${serial}`, SK: "META" }).then((item) => (item === undefined ? undefined : OnuRow.parse(item))),
  };
  const transport: HttpTransport = async (request) => {
    requests.push(`${request.method} ${request.path}`);
    if (network.outage) return { status: 503, headers: { "retry-after": "0" }, body: JSON.stringify({ error: "ERROR_503" }) };
    const response = await handleNetworkRequest({ method: request.method, path: request.path, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) }, { store, now, sleep: async () => undefined });
    return { status: response.status, headers: response.headers, body: response.body };
  };
  Object.assign(network, { client: createNetworkClient({ transport, faults: { networkFault: async () => undefined }, sleep: async () => undefined, now }) });
  return network;
}

export interface LocalDispatch {
  /** A command of the dispatcher (reschedule, reassign, cancel), published to `FeedEvents` in process. */
  run(command: DispatchCommand): Promise<void>;
  /** What `FeedEvents` answered to each published event. */
  readonly accepted: string[];
}

export function localDispatch(rows: readonly DispatchOrderItem[], feed: () => DispatchFeedDeps, now: () => Date): LocalDispatch {
  const store = memoryDispatchStore(rows);
  const accepted: string[] = [];
  let delivery = 0;
  const publisher = recordingPublisher(async (event) => {
    delivery += 1;
    const bus = toBusEvent(event, { id: `local-dispatch-${delivery}`, time: now().toISOString(), account: "000000000000", region: "us-east-1" });
    accepted.push(await acceptDispatchEvent(bus, feed()));
  });
  return {
    accepted,
    async run(command) {
      const outcome = await runCommand({ store, publisher, now }, command);
      if (!outcome.ok) throw new Error(`the dispatcher refused the ${command.action}: ${outcome.code}`);
    },
  };
}
