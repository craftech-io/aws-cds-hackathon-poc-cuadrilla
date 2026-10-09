// One command of the demo clock view at a time: it runs the mutation, keeps its outcome (a sentence for a
// success, the error for a refusal) and asks the shell's clock again right after, so the bar, the busy
// state and the next events follow at once.
import { useCallback } from "react";
import { useWorldClock } from "../../context/WorldClockContext";
import { type ActionState, useAction } from "../../lib/use-remote";

export interface ClockCommand {
  readonly state: ActionState<string>;
  readonly running: boolean;
  /** Runs `perform` and keeps `describe(result)` as the outcome. */
  run<T>(perform: () => Promise<T>, describe: (result: T) => string): void;
  reset(): void;
}

export function useClockCommand(): ClockCommand {
  const { refresh } = useWorldClock();
  const action = useAction(async (task: () => Promise<string>) => {
    try {
      return await task();
    } finally {
      refresh();
    }
  });
  const { run: runAction, reset } = action;
  const run = useCallback(<T>(perform: () => Promise<T>, describe: (result: T) => string) => void runAction(async () => describe(await perform())), [runAction]);
  return { state: action.state, running: action.state.status === "running", run, reset };
}
