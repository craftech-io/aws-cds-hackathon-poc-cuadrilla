// The sign-up's own tRPC client (ADR-0025 §3): `signup.start` is served only as one call, `POST
// /api/signup.start` without `batch` (routers/edge.ts answers 400 to anything else), so this client uses
// `httpLink`, NEVER `httpBatchLink` (the console's client batches, lib/trpc.ts). Its `fetch` is the one of
// lib/waf-token.ts, which carries the AWS WAF token the edge's Challenge asks for, with a timeout and no
// retry: a start is not idempotent, so a lost answer is never replayed (the model reuses its ticket).
import { createTRPCClient, httpLink } from "@trpc/client";
import { z } from "zod";
import { API_URL } from "../../lib/env";
import type { AppRouter } from "../../lib/trpc-router";
import type { WafToken } from "../../lib/waf-token";
import type { SignupStartAnswer, SignupStartInput } from "./signup-model";

const START_TIMEOUT_MS = 15_000;

const Answer = z.object({ ticket: z.string().min(1), username: z.string().regex(/^gst-[0-9A-HJKMNP-TV-Z]{26}$/), expiresAt: z.string().min(1) });

export interface SignupClient {
  start(input: SignupStartInput): Promise<SignupStartAnswer>;
}

export function createSignupClient(waf: Pick<WafToken, "fetch">, url: string = API_URL): SignupClient {
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url,
        fetch: (input, init) => {
          const timeout = AbortSignal.timeout(START_TIMEOUT_MS);
          const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
          return waf.fetch(input, { ...init, signal });
        },
      }),
    ],
  });
  return {
    start: async (input) => Answer.parse(await client.signup.start.mutate(input)),
  };
}
