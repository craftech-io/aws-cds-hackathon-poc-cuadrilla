/// <reference path="../../sst-env.d.ts" />
// AgentCore Memory as the purge sees it (worlds/memory-purge.ts), over the data plane of
// `@aws-sdk/client-bedrock-agentcore` (each command checked in the installed `.d.ts`): `ListEvents`,
// `DeleteEvent`, `ListMemoryRecords` (whose `namespace` is a prefix) and `DeleteMemoryRecord`, the
// capability MEMORY_ADMIN of infra/iam-capabilities.ts, plus `ListSessions` when the role holds it (a
// role without it gets the sessions the purge computes from the world, never an error). The Memory id
// comes from the `Memory` link (`Resource`, never `process.env`). Listings page to the end; every call
// has the deadline and retry budget of lib/clients.ts; deleting something already gone is not an error.
import {
  AccessDeniedException,
  BedrockAgentCoreClient,
  DeleteEventCommand,
  DeleteMemoryRecordCommand,
  ListEventsCommand,
  ListMemoryRecordsCommand,
  ListSessionsCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-bedrock-agentcore";
import { z } from "zod";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import type { MemoryAdmin } from "./memory-purge";

const MemoryLink = z.object({ memoryId: z.string().min(1) });

/** Root of every installer namespace (docs/architecture.md §9.3). */
const INSTALLERS_ROOT = "/installers/";

/** Largest page the listings ask for. */
const PAGE_SIZE = 100;

async function ignoreMissing(call: Promise<unknown>): Promise<void> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
}

/** A listing of an actor or session Memory never saw answers "not found": an empty list. */
async function emptyWhenMissing(list: () => Promise<string[]>): Promise<string[]> {
  try {
    return await list();
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return [];
    throw error;
  }
}

async function pages<T>(fetch: (nextToken: string | undefined) => Promise<{ readonly items: readonly T[]; readonly nextToken?: string | undefined }>): Promise<T[]> {
  const all: T[] = [];
  let nextToken: string | undefined;
  do {
    const page = await fetch(nextToken);
    all.push(...page.items);
    nextToken = page.nextToken;
  } while (nextToken);
  return all;
}

export interface MemoryAdminOptions {
  readonly memoryId?: () => string;
  readonly client?: Pick<BedrockAgentCoreClient, "send">;
}

export function agentCoreMemoryAdmin(options: MemoryAdminOptions = {}): MemoryAdmin {
  const memoryId = options.memoryId ?? (() => readLinked("Memory", MemoryLink).memoryId);
  let client = options.client;
  const agentCore = (): Pick<BedrockAgentCoreClient, "send"> => (client ??= new BedrockAgentCoreClient(awsClientConfig(CLIENT_TIMEOUTS.memory)));
  let mayListSessions = true;

  return {
    async listSessionIds(actorId) {
      if (!mayListSessions) return [];
      try {
        return await emptyWhenMissing(() =>
          pages(async (nextToken) => {
            const page = await agentCore().send(new ListSessionsCommand({ memoryId: memoryId(), actorId, maxResults: PAGE_SIZE, nextToken }));
            return { items: (page.sessionSummaries ?? []).flatMap((session) => (session.sessionId ? [session.sessionId] : [])), nextToken: page.nextToken };
          }),
        );
      } catch (error) {
        // MEMORY_ADMIN without ListSessions: the purge goes with the sessions it computed.
        if (!(error instanceof AccessDeniedException)) throw error;
        mayListSessions = false;
        return [];
      }
    },

    listEventIds: (actorId, sessionId) =>
      emptyWhenMissing(() =>
        pages(async (nextToken) => {
          const page = await agentCore().send(new ListEventsCommand({ memoryId: memoryId(), actorId, sessionId, includePayloads: false, maxResults: PAGE_SIZE, nextToken }));
          return { items: (page.events ?? []).flatMap((event) => (event.eventId ? [event.eventId] : [])), nextToken: page.nextToken };
        }),
      ),

    async deleteEvent(actorId, sessionId, eventId) {
      await ignoreMissing(agentCore().send(new DeleteEventCommand({ memoryId: memoryId(), actorId, sessionId, eventId })));
    },

    listRecordIds: (namespacePrefix) =>
      emptyWhenMissing(() =>
        pages(async (nextToken) => {
          const page = await agentCore().send(new ListMemoryRecordsCommand({ memoryId: memoryId(), namespace: namespacePrefix, maxResults: PAGE_SIZE, nextToken }));
          return { items: (page.memoryRecordSummaries ?? []).flatMap((record) => (record.memoryRecordId ? [record.memoryRecordId] : [])), nextToken: page.nextToken };
        }),
      ),

    async deleteRecord(recordId) {
      await ignoreMissing(agentCore().send(new DeleteMemoryRecordCommand({ memoryId: memoryId(), memoryRecordId: recordId })));
    },

    async listRecordActors() {
      const namespaces = await pages(async (nextToken) => {
        const page = await agentCore().send(new ListMemoryRecordsCommand({ memoryId: memoryId(), namespace: INSTALLERS_ROOT, maxResults: PAGE_SIZE, nextToken }));
        return { items: (page.memoryRecordSummaries ?? []).flatMap((record) => record.namespaces ?? []), nextToken: page.nextToken };
      });
      return actorsOfNamespaces(namespaces);
    },
  };
}

/** The actor of each `/installers/<actorId>/…` namespace, once. */
export function actorsOfNamespaces(namespaces: readonly string[]): string[] {
  const actors = new Set<string>();
  for (const namespace of namespaces) {
    const actor = /^\/installers\/([^/]+)\//.exec(namespace)?.[1];
    if (actor !== undefined) actors.add(actor);
  }
  return [...actors];
}
