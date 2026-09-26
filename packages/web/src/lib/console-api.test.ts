import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ContractError, type ProcedureTransport, createConsoleApi } from "./console-api";

function transport(answer: unknown) {
  const calls: Array<{ kind: string; path: string; input: unknown; signal: AbortSignal | undefined }> = [];
  const fake: ProcedureTransport = {
    query: async (path, input, opts) => {
      calls.push({ kind: "query", path, input, signal: opts?.signal });
      return answer;
    },
    mutation: async (path, input, opts) => {
      calls.push({ kind: "mutation", path, input, signal: opts?.signal });
      return answer;
    },
  };
  return { fake, calls };
}

const Answer = z.object({ busy: z.boolean() });

describe("createConsoleApi", () => {
  it("calls the procedure by path with its input and the caller's signal, and parses the answer", async () => {
    const { fake, calls } = transport({ busy: false });
    const controller = new AbortController();
    await expect(createConsoleApi(fake).query("clock.get", undefined, Answer, controller.signal)).resolves.toEqual({ busy: false });
    await expect(createConsoleApi(fake).mutation("clock.advance", { minutes: 10 }, Answer)).resolves.toEqual({ busy: false });
    expect(calls).toEqual([
      { kind: "query", path: "clock.get", input: undefined, signal: controller.signal },
      { kind: "mutation", path: "clock.advance", input: { minutes: 10 }, signal: undefined },
    ]);
  });

  it("turns an answer that breaks the contract into a ContractError naming the fields", async () => {
    const { fake } = transport({ busy: "yes" });
    const failure = await createConsoleApi(fake)
      .query("clock.get", undefined, Answer)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContractError);
    expect(failure).toMatchObject({ path: "clock.get", issues: [expect.stringContaining("busy")] });
  });

  it("lets a refusal of the BFF through as it came", async () => {
    const refusal = new Error("WORLD_BUSY");
    const fake: ProcedureTransport = { query: () => Promise.reject(refusal), mutation: () => Promise.reject(refusal) };
    await expect(createConsoleApi(fake).mutation("clock.advanceToNext", undefined, z.unknown())).rejects.toBe(refusal);
  });
});
