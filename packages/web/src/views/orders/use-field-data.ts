// Data plumbing the field-work views share: the BFF addressed by procedure path with zod at the edge
// (lib/console-api.ts), and a query that follows the shell's clock poll, so a view refreshes every 3 s
// while the world is busy and every 15 s at rest ("actualización en vivo", docs/design-brief.md §6).
import { useMemo } from "react";
import type { z } from "zod";
import { useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { type ConsoleApi, consoleApiOf } from "../../lib/console-api";
import { type Remote, useRemote } from "../../lib/use-remote";

export function useConsoleApi(): ConsoleApi {
  const { trpc } = useSession();
  return useMemo(() => consoleApiOf(trpc), [trpc]);
}

/**
 * `path` with `input`, answered as `schema`, asked again with every answer of the clock poll.
 * `input === undefined` asks nothing (a role or a selection that does not need it).
 */
export function useLiveQuery<T>(path: string, input: unknown, schema: z.ZodType<T>, enabled = true): Remote<T> {
  const api = useConsoleApi();
  const { tick } = useWorldClock();
  const key = enabled ? `${path}:${JSON.stringify(input ?? null)}:${tick}` : null;
  return useRemote(key, (signal) => api.query(path, input, schema, signal));
}
