// tRPC client of the console: same origin, `/api` behind the Router, id token in the
// Authorization header. The BFF resolves the principal from that token (WP-13).
import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";
import { API_URL } from "./env";
import { fetchWithRetry } from "./http";
import type { AppRouter } from "./trpc-router";

export type ConsoleClient = TRPCClient<AppRouter>;

const REQUEST_TIMEOUT_MS = 20_000;

export function createConsoleClient(getIdToken: () => string | undefined): ConsoleClient {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: API_URL,
        fetch: (input, init) => fetchWithRetry(input, init, { timeoutMs: REQUEST_TIMEOUT_MS }),
        headers: () => {
          const token = getIdToken();
          return token ? { authorization: `Bearer ${token}` } : {};
        },
      }),
    ],
  });
}
