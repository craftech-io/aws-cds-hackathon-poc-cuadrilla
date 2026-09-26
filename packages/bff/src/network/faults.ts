// Faults of a world for the orchestrator (docs/architecture-integrations.md §6, docs/tool-catalog.md
// `network.setFaults`): the `QaDriver` writes `Runtime/FAULTS#<clockId>` / `META` with a `network`
// attribute, and clients read faults only for `qa-*` clocks, so a demo or judge world never pays the
// read nor can be faulted. The client forwards the fault to the mock as `X-Fault`.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { NetworkFault } from "@cuadrilla/network-contract";
import { parseClockId } from "@cuadrilla/shared";
import { z } from "zod";
import { dynamoDocumentClient } from "../lib/clients";
import { tableName } from "../lib/resource";

/** Key of a world's faults in `Runtime` (one item per world, one attribute per faulted client). */
export function faultsKey(clockId: string): { readonly PK: string; readonly SK: "META" } {
  return { PK: `FAULTS#${clockId}`, SK: "META" };
}

/** The `network` attribute of the faults item; other clients' attributes pass through untouched. */
export const NetworkFaultsItem = z.looseObject({ network: NetworkFault.optional() });

/** Only QA worlds can have faults (`qa-<runId>-<scenario>`); evaluation, demo and judge worlds never. */
export function mayHaveFaults(clockId: string): boolean {
  return parseClockId(clockId)?.kind === "QA";
}

export interface NetworkFaultReader {
  /** Called only for clocks where `mayHaveFaults` holds. */
  networkFault(clockId: string): Promise<NetworkFault | undefined>;
}

export interface FaultsGetter {
  send(command: GetCommand): Promise<{ Item?: Record<string, unknown> }>;
}

export function runtimeFaultReader(client: FaultsGetter = dynamoDocumentClient(), table: () => string = () => tableName("Runtime")): NetworkFaultReader {
  return {
    async networkFault(clockId) {
      const out = await client.send(new GetCommand({ TableName: table(), Key: faultsKey(clockId) }));
      if (out.Item === undefined) return undefined;
      return NetworkFaultsItem.parse(out.Item).network;
    },
  };
}
