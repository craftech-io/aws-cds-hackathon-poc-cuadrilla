// A polling loop without React: load, report, wait the interval the last result asks for, again.
// One load at a time (a `refresh` during a load runs one more right after it), no timer while
// paused (a hidden tab costs nothing), and nothing reported after `stop`. The shell polls the world
// clock with it; the timers are injectable so the loop is tested with fake time.

export type PollResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export interface PollerTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface PollerOptions<T> {
  load(signal: AbortSignal): Promise<T>;
  /** Milliseconds until the next load, from the result just reported. */
  intervalOf(result: PollResult<T>): number;
  onResult(result: PollResult<T>): void;
  timers?: PollerTimers;
}

export interface Poller {
  /** First load now, then keep polling. */
  start(): void;
  /** Load now (after an action that changed what the poll shows). */
  refresh(): void;
  /** Stop scheduling (a hidden tab); the load in flight still reports. */
  pause(): void;
  /** Leave the pause with a load now. */
  resume(): void;
  /** Stop for good: abort the load in flight and report nothing more. */
  stop(): void;
}

const DEFAULT_TIMERS: PollerTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createPoller<T>({ load, intervalOf, onResult, timers = DEFAULT_TIMERS }: PollerOptions<T>): Poller {
  let timer: unknown;
  let inFlight: AbortController | undefined;
  let again = false;
  let paused = false;
  let stopped = false;

  const clearTimer = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };

  const schedule = (ms: number) => {
    clearTimer();
    if (!paused && !stopped) timer = timers.set(run, ms);
  };

  function run(): void {
    timer = undefined;
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    const controller = new AbortController();
    inFlight = controller;
    load(controller.signal).then(
      (value) => settle(controller, { ok: true, value }),
      (error: unknown) => settle(controller, { ok: false, error }),
    );
  }

  function settle(controller: AbortController, result: PollResult<T>): void {
    if (inFlight === controller) inFlight = undefined;
    if (stopped || controller.signal.aborted) return;
    onResult(result);
    if (again) {
      again = false;
      schedule(0);
      return;
    }
    schedule(intervalOf(result));
  }

  return {
    start: () => {
      stopped = false;
      run();
    },
    refresh: () => {
      clearTimer();
      run();
    },
    pause: () => {
      paused = true;
      clearTimer();
    },
    resume: () => {
      if (!paused) return;
      paused = false;
      clearTimer();
      run();
    },
    stop: () => {
      stopped = true;
      clearTimer();
      inFlight?.abort();
      inFlight = undefined;
    },
  };
}
