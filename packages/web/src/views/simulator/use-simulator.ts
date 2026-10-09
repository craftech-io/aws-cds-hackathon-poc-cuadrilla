// State of the phone simulator without a state library (CLAUDE.md): the identities of the user's world,
// the chosen one (from `?identity=` the first time), its chat polled every 3 s while something is in
// progress and every 15 s at rest (never while the tab is hidden), once more on every answer of the
// shell's clock and right after each action; the synthetic set and the tour's quick messages, read
// once; and one action at a time, so a double tap never sends twice.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { type ApiError, apiErrorOf, isAbortError } from "../../lib/api-error";
import { consoleApiOf } from "../../lib/console-api";
import { type Poller, createPoller } from "../../lib/poller";
import { useRouter } from "../../lib/router";
import { type Action, type Remote, useAction, useRemote } from "../../lib/use-remote";
import { IDLE_POLL_MS, LIVE_POLL_MS } from "../../lib/world-clock";
import { type Catalog, type QuickMessage, type SimAction, type SimIdentities, type SimulatorApi, type Thread, createSimulatorApi } from "./simulator-api";
import { defaultIdentity, isTyping, phoneItems } from "./simulator-model";

export type ThreadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly thread: Thread }
  | { readonly status: "error"; readonly error: ApiError; readonly thread?: Thread };

export interface SimulatorState {
  readonly api: SimulatorApi;
  readonly identities: Remote<SimIdentities>;
  readonly identity: string | undefined;
  choose(identity: string): void;
  readonly thread: ThreadState;
  readonly typing: boolean;
  readonly catalog: Remote<Catalog>;
  readonly quick: Remote<QuickMessage[]>;
  readonly action: Action<SimAction, unknown>;
  /** Runs an action, then reads the chat and the clock again. */
  act(action: SimAction): Promise<boolean>;
}

const threadOf = (state: ThreadState): Thread | undefined => (state.status === "loading" ? undefined : state.thread);

/** Starts the poll and keeps it paused while the tab is hidden; returns what stops it. */
function whileVisible(poller: Poller): () => void {
  const onChange = () => (document.hidden ? poller.pause() : poller.resume());
  document.addEventListener("visibilitychange", onChange);
  poller.start();
  if (document.hidden) poller.pause();
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    poller.stop();
  };
}

function failed(error: unknown, before: ThreadState): ThreadState {
  const thread = threadOf(before);
  return thread === undefined ? { status: "error", error: apiErrorOf(error) } : { status: "error", error: apiErrorOf(error), thread };
}

function useThread(api: SimulatorApi, identity: string | undefined, fast: boolean): { readonly state: ThreadState; refresh(): void } {
  const [state, setState] = useState<ThreadState>({ status: "loading" });
  const poller = useRef<Poller | undefined>(undefined);
  const fastRef = useRef(fast);
  useEffect(() => {
    fastRef.current = fast;
  });

  useEffect(() => {
    if (identity === undefined) return;
    setState({ status: "loading" });
    const instance = createPoller<Thread>({
      load: (signal) => api.thread(identity, signal),
      intervalOf: () => (fastRef.current ? LIVE_POLL_MS : IDLE_POLL_MS),
      onResult: (result) => {
        if (result.ok) setState({ status: "ready", thread: result.value });
        else if (!isAbortError(result.error)) setState((current) => failed(result.error, current));
      },
    });
    poller.current = instance;
    const stop = whileVisible(instance);
    return () => {
      stop();
      poller.current = undefined;
    };
  }, [api, identity]);

  const refresh = useCallback(() => poller.current?.refresh(), []);
  return { state, refresh };
}

export function useSimulator(): SimulatorState {
  const { trpc } = useSession();
  const { search } = useRouter();
  const clock = useWorldClock();
  const api = useMemo(() => createSimulatorApi(consoleApiOf(trpc)), [trpc]);
  const identities = useRemote("simulator.identities", (signal) => api.identities(signal));
  const catalog = useRemote("simulator.catalog", (signal) => api.catalog(signal));
  const quick = useRemote("simulator.quickMessages", (signal) => api.quickMessages(signal));
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [asked] = useState(() => search.get("identity"));

  const list = identities.state.status === "ready" ? identities.state.data.identities : undefined;
  const simulated = identities.state.status === "ready" && identities.state.data.simulated;
  const identity = list === undefined || !simulated ? undefined : list.some((item) => item.identity === chosen) ? chosen : defaultIdentity(list, asked);

  const busy = clock.clock?.busy === true;
  const pending = clock.clock?.pending ?? [];
  const [awaiting, setAwaiting] = useState(false);
  const thread = useThread(api, identity, busy || awaiting);
  const items = phoneItems(threadOf(thread.state)?.bubbles ?? []);
  const typing = isTyping(items, busy, pending);

  // The shell's clock answered: the world may have moved, so the chat is read again.
  const { refresh: refreshThread } = thread;
  const { tick, refresh: refreshClock } = clock;
  useEffect(() => {
    if (tick > 0) refreshThread();
  }, [tick, refreshThread]);

  const action = useAction((request: SimAction) => api.run(request));
  const { run } = action;
  const act = useCallback(
    async (request: SimAction) => {
      const result = await run(request);
      refreshThread();
      // The world is busy now (an event in flight): the shell polls every 3 s while it is.
      refreshClock();
      if (result !== undefined) setAwaiting(true);
      return result !== undefined;
    },
    [run, refreshThread, refreshClock],
  );

  // The fast cadence after an action lasts until the world settles again.
  useEffect(() => {
    if (!awaiting) return;
    const settle = setTimeout(() => setAwaiting(false), 30_000);
    return () => clearTimeout(settle);
  }, [awaiting]);

  return { api, identities, identity, choose: setChosen, thread: thread.state, typing, catalog, quick, action, act };
}
