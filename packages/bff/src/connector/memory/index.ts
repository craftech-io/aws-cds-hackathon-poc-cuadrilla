// In-memory adapter: the same `Connector` code over a map, for vitest and the local flows
// (`tests/flows/`). A fixed clock and a deterministic id sequence make assertions stable.
import { createConnector } from "../dynamo/connector";
import { createRepoContext, type RepoContext } from "../dynamo/repo";
import type { Connector } from "../ports";
import type { WorldPolicy } from "../world";
import { MemoryTableClient } from "./table-client";

export interface MemoryConnector {
  readonly connector: Connector;
  readonly client: MemoryTableClient;
  readonly ctx: RepoContext;
}

export interface MemoryConnectorOptions {
  /** Real clock of the connector (`createdAt`, TTLs); defaults to the machine clock. */
  readonly now?: () => Date;
  /** Ids the connector names itself; defaults to `id-0001`, `id-0002`… */
  readonly newId?: () => string;
  readonly worldPolicy?: WorldPolicy;
}

export function createMemoryConnector(options: MemoryConnectorOptions = {}): MemoryConnector {
  const client = new MemoryTableClient();
  let sequence = 0;
  const ctx = createRepoContext(client, {
    ...(options.now ? { now: options.now } : {}),
    newId: options.newId ?? (() => `id-${(++sequence).toString().padStart(4, "0")}`),
    ...(options.worldPolicy ? { worldPolicy: options.worldPolicy } : {}),
  });
  return { connector: createConnector(ctx), client, ctx };
}
