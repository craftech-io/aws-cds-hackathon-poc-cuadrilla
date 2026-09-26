// deadline: every external call runs under one (lib/crypto.ts is covered by crypto.test.ts).
import { describe, expect, it } from "vitest";
import { DeadlineError, withDeadline } from "./deadline";

describe("deadline", () => {
  it("returns the result when the call finishes in time", async () => {
    expect(await withDeadline("network.getOnuStatus", 1_000, async () => "ok")).toBe("ok");
  });

  it("aborts and throws a retryable DeadlineError when it does not", async () => {
    let aborted = false;
    const slow = withDeadline("network.getOnuStatus", 10, (signal) => new Promise<string>((resolve) => { signal.addEventListener("abort", () => { aborted = true; }); setTimeout(() => resolve("late"), 200); }));
    await expect(slow).rejects.toBeInstanceOf(DeadlineError);
    await expect(slow).rejects.toMatchObject({ operation: "network.getOnuStatus", timeoutMs: 10, retryable: true });
    expect(aborted).toBe(true);
    await expect(withDeadline("x", 0, async () => 1)).rejects.toThrow(RangeError);
  });
});
