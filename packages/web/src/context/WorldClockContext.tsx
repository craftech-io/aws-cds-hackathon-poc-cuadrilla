// The clock of the user's world for the whole console (ADR-0010): the shell polls `clock.get` every
// 3 s while something is in progress and every 15 s at rest, never while the tab is hidden, and every
// view reads the same answer. `tick` changes with every answer, so a view that adds it to the key of
// its query reloads in step with the shell ("actualización en vivo", docs/design-brief.md §6). The
// bar's controls ("Avanzar al próximo evento", "+10 min", "+1 h") live here too: one at a time, and
// the clock is asked again as soon as one finishes.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { type ApiError, apiErrorOf, isAbortError } from "../lib/api-error";
import { consoleApiOf } from "../lib/console-api";
import { type Poller, createPoller } from "../lib/poller";
import { type ActionState, useAction } from "../lib/use-remote";
import { AdvanceInput, type AdvanceStep, CLOCK_PROCEDURES, IDLE_POLL_MS, WorldClock, pollIntervalMs } from "../lib/world-clock";
import { useSession } from "./SessionContext";

export type WorldClockState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly clock: WorldClock }
  /** `clock` is the last good answer, kept on screen while the poll keeps failing. */
  | { readonly status: "error"; readonly error: ApiError; readonly clock?: WorldClock };

export type ClockControl = { readonly kind: "next" } | { readonly kind: "advance"; readonly minutes: AdvanceStep };

export interface WorldClockValue {
  readonly state: WorldClockState;
  /** The last good answer, whatever the state of the current poll. */
  readonly clock: WorldClock | undefined;
  /** Changes with every answer of the poll. */
  readonly tick: number;
  /** Asks the clock again now (after an action that moved it or made the world busy). */
  refresh(): void;
  readonly control: ActionState<unknown>;
  run(control: ClockControl): void;
  /** Clears the outcome of the last control (its error, once the person has seen it). */
  dismissControl(): void;
}

const WorldClockContext = createContext<WorldClockValue | undefined>(undefined);

// The controls answer whatever the BFF returns; the shell reads the clock again right after.
const AnyAnswer = z.unknown();

function lastClock(state: WorldClockState): WorldClock | undefined {
  return state.status === "loading" ? undefined : state.clock;
}

export function WorldClockProvider({ children }: { readonly children: ReactNode }) {
  const { trpc } = useSession();
  const api = useMemo(() => consoleApiOf(trpc), [trpc]);
  const [state, setState] = useState<WorldClockState>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const poller = useRef<Poller | undefined>(undefined);

  useEffect(() => {
    const instance = createPoller<WorldClock>({
      load: (signal) => api.query(CLOCK_PROCEDURES.get, undefined, WorldClock, signal),
      intervalOf: (result) => (result.ok ? pollIntervalMs(result.value) : IDLE_POLL_MS),
      onResult: (result) => {
        if (result.ok) setState({ status: "ready", clock: result.value });
        else if (!isAbortError(result.error)) setState((current) => ({ status: "error", error: apiErrorOf(result.error), ...withClock(lastClock(current)) }));
        setTick((value) => value + 1);
      },
    });
    poller.current = instance;
    const onVisibility = () => (document.hidden ? instance.pause() : instance.resume());
    document.addEventListener("visibilitychange", onVisibility);
    instance.start();
    if (document.hidden) instance.pause();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      instance.stop();
      poller.current = undefined;
    };
  }, [api]);

  const refresh = useCallback(() => poller.current?.refresh(), []);

  const action = useAction(async (control: ClockControl) => {
    try {
      if (control.kind === "next") return await api.mutation(CLOCK_PROCEDURES.advanceToNext, undefined, AnyAnswer);
      return await api.mutation(CLOCK_PROCEDURES.advance, AdvanceInput.parse({ minutes: control.minutes }), AnyAnswer);
    } finally {
      poller.current?.refresh();
    }
  });
  const { run: runAction, reset: dismissControl } = action;
  const run = useCallback((control: ClockControl) => void runAction(control), [runAction]);

  const value = useMemo<WorldClockValue>(
    () => ({ state, clock: lastClock(state), tick, refresh, control: action.state, run, dismissControl }),
    [state, tick, refresh, action.state, run, dismissControl],
  );
  return <WorldClockContext.Provider value={value}>{children}</WorldClockContext.Provider>;
}

function withClock(clock: WorldClock | undefined): { readonly clock?: WorldClock } {
  return clock ? { clock } : {};
}

export function useWorldClock(): WorldClockValue {
  const value = useContext(WorldClockContext);
  if (!value) throw new Error("useWorldClock must be used inside WorldClockProvider");
  return value;
}
