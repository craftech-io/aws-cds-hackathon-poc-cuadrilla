// Calls to the BFF by procedure path, with the answer parsed by zod at the edge. The shell uses it
// for the procedures it depends on (`brand.get`, `clock.get`, the clock controls): they travel
// through the same tRPC client, links, token, timeout and retry as every typed call, and what comes
// back is checked against the contract the shell was written for, so a mismatch surfaces as an
// error the views know how to show instead of an undefined field deep in a component.
import { getUntypedClient } from "@trpc/client";
import type { z } from "zod";
import type { ConsoleClient } from "./trpc";

/** The two operations of the untyped tRPC client the shell needs (a fake in the tests). */
export interface ProcedureTransport {
  query(path: string, input?: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
  mutation(path: string, input?: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
}

/** The answer did not match the contract: a BFF of another version, never the user's fault. */
export class ContractError extends Error {
  override readonly name = "ContractError";
  constructor(
    readonly path: string,
    readonly issues: readonly string[],
  ) {
    super(`unexpected answer from ${path}`);
  }
}

export interface ConsoleApi {
  query<T>(path: string, input: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T>;
  mutation<T>(path: string, input: unknown, schema: z.ZodType<T>): Promise<T>;
}

function parsed<T>(path: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ContractError(path, result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`));
  return result.data;
}

export function createConsoleApi(transport: ProcedureTransport): ConsoleApi {
  return {
    async query(path, input, schema, signal) {
      const value = await transport.query(path, input, signal ? { signal } : undefined);
      return parsed(path, schema, value);
    },
    async mutation(path, input, schema) {
      return parsed(path, schema, await transport.mutation(path, input));
    },
  };
}

/** The same client the session built (token, links, retry), addressed by path. */
export function consoleApiOf(client: ConsoleClient): ConsoleApi {
  return createConsoleApi(getUntypedClient(client));
}
