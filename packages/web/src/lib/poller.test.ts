import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PollResult, createPoller } from "./poller";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A poller over loads the test answers by hand; `interval` is what each result asks for. */
function harness(interval: (result: PollResult<number>) => number = () => 1_000) {
  const loads: Array<{ signal: AbortSignal; answer: Deferred<number> }> = [];
  const results: PollResult<number>[] = [];
  const poller = createPoller<number>({
    load: (signal) => {
      const answer = deferred<number>();
      loads.push({ signal, answer });
      return answer.promise;
    },
    intervalOf: interval,
    onResult: (result) => results.push(result),
  });
  return { poller, loads, results };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPoller", () => {
  it("loads at once, then again after the interval the last result asked for", async () => {
    const { poller, loads, results } = harness((result) => (result.ok && result.value > 0 ? 3_000 : 15_000));
    poller.start();
    expect(loads).toHaveLength(1);
    loads[0]?.answer.resolve(1);
    await flush();
    expect(results).toEqual([{ ok: true, value: 1 }]);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(loads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(loads).toHaveLength(2);
    loads[1]?.answer.resolve(0);
    await flush();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(loads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(loads).toHaveLength(3);
    poller.stop();
  });

  it("reports a failed load and keeps polling", async () => {
    const { poller, loads, results } = harness();
    poller.start();
    loads[0]?.answer.reject(new Error("offline"));
    await flush();
    expect(results[0]).toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loads).toHaveLength(2);
    poller.stop();
  });

  it("never runs two loads at once: a refresh during a load runs one more right after it", async () => {
    const { poller, loads } = harness();
    poller.start();
    poller.refresh();
    poller.refresh();
    expect(loads).toHaveLength(1);
    loads[0]?.answer.resolve(1);
    await flush();
    expect(loads).toHaveLength(2);
    loads[1]?.answer.resolve(2);
    await flush();
    expect(loads).toHaveLength(2);
    poller.stop();
  });

  it("a refresh while waiting loads now and restarts the wait", async () => {
    const { poller, loads } = harness();
    poller.start();
    loads[0]?.answer.resolve(1);
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    poller.refresh();
    expect(loads).toHaveLength(2);
    loads[1]?.answer.resolve(2);
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(loads).toHaveLength(2);
    poller.stop();
  });

  it("schedules nothing while paused and loads at once on resume", async () => {
    const { poller, loads } = harness();
    poller.start();
    poller.pause();
    loads[0]?.answer.resolve(1);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loads).toHaveLength(1);
    poller.resume();
    expect(loads).toHaveLength(2);
    poller.resume();
    expect(loads).toHaveLength(2);
    poller.stop();
  });

  it("aborts the load in flight on stop and reports nothing after it", async () => {
    const { poller, loads, results } = harness();
    poller.start();
    poller.stop();
    expect(loads[0]?.signal.aborted).toBe(true);
    loads[0]?.answer.resolve(1);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(results).toEqual([]);
    expect(loads).toHaveLength(1);
  });
});
