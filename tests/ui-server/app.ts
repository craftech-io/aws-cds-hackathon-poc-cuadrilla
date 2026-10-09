// The back half of the local UI server (docs/test-plan.md §2 and §3, level UI), on the base of
// scripts/landing/console-server.ts: the real `appRouter` behind `/api` and the S3 emulator behind `/s3`,
// on the same origin as the page, over one in-memory world (world.ts). The console's ports are the
// memory ones of the router tests (packages/bff/src/routers/console-testing.ts) with this server's
// origin for the presigned links, the repository's seed files as the buckets' content, and the real
// `InboundWhatsApp` in process for the phone simulator (inbound.ts). The own sign-up (`signup.start`
// over memory), the guest's portada (`guest.*`) and the account (`account.*`) answer as in the stage.
//
// This server plays the Router's and routers/edge.ts's part for what it answers: it forwards only the
// headers the BFF reads and hands tRPC the viewer's address as the edge would after the origin check.
// Id tokens are checked by the BFF's real verifier against the JWKS the entry gives it (main.ts), never
// in the Lambda. Nothing reaches AWS.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { type IdTokenVerifierConfig, createCognitoIdTokenVerifier, staticJwksFetcher } from "../../packages/bff/src/auth/jwt";
import { createUserDirectory } from "../../packages/bff/src/auth/staff";
import type { MemoryConnector } from "../../packages/bff/src/connector/index";
import { systemClock } from "../../packages/bff/src/lib/clock";
import { createLogger } from "../../packages/bff/src/lib/log";
import { API_PREFIX } from "../../packages/bff/src/routers/api-path";
import { bindConsolePorts } from "../../packages/bff/src/routers/console-ports";
import { type MemoryConsolePorts, memoryConsolePorts } from "../../packages/bff/src/routers/console-testing";
import type { ContextDeps } from "../../packages/bff/src/routers/deps";
import { appRouter } from "../../packages/bff/src/routers/index";
import { createContextFactory } from "../../packages/bff/src/routers/trpc";
import { memorySignupPorts } from "../../packages/bff/src/signup/testing";
import { stampingVerifier } from "./identity";
import { type LocalInbound, UI_SIM_ENVELOPE_KEY, createLocalInbound } from "./inbound";
import { handleS3 } from "./s3-emulator";
import { UI_PHONE_HASH_KEY, createUiWorld, repositoryObject, uiPhoneHash } from "./world";

export interface UiAppOptions {
  /** `http://127.0.0.1:<port>`: the page, the API and the emulator share it. */
  readonly origin: string;
  /** The placeholder pool of the Vite build and the audiences its tokens may carry. */
  readonly pool: { readonly userPoolId: string; readonly clientIds: readonly string[] };
  /** Public half of the Playwright run's key. */
  readonly jwks: { readonly keys: readonly unknown[] };
}

export interface UiApp {
  readonly memory: MemoryConnector;
  readonly ports: MemoryConsolePorts;
  readonly inbound: LocalInbound;
  /** Answers `/api` and `/s3`; false for anything else (the caller hands it to Vite). */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

/** The headers the Router forwards to the BFF and the BFF reads. */
const FORWARDED = ["authorization", "x-correlation-id"] as const;

function forwardedHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

export async function createUiApp(options: UiAppOptions): Promise<UiApp> {
  const memory = await createUiWorld();
  const log = createLogger({ level: "warn", bindings: { service: "ui-server" } });
  const base = memoryConsolePorts({ connector: memory.connector, client: memory.client, hashPhone: uiPhoneHash, realClock: systemClock, origin: options.origin, fallback: repositoryObject });
  const inbound = createLocalInbound({ connector: memory.connector, objects: base.objects, phoneHashKey: UI_PHONE_HASH_KEY, kill: base.kill, logger: log });
  base.onInbound = inbound.handle;
  const ports: MemoryConsolePorts = { ...base, simEnvelopeKey: () => UI_SIM_ENVELOPE_KEY };
  const fetcher = staticJwksFetcher(options.jwks);
  const verifiers = options.pool.clientIds.map((clientId) => createCognitoIdTokenVerifier({ userPoolId: options.pool.userPoolId, clientId } satisfies IdTokenVerifierConfig, { fetcher }));
  const signup = memorySignupPorts();
  const deps: ContextDeps = bindConsolePorts(
    {
      verifier: stampingVerifier(verifiers, memory.connector),
      connector: memory.connector,
      users: createUserDirectory(memory.connector.isps, () => new Date(), 0),
      mocks: () => Promise.resolve({ network: "OK", dispatch: "OK" }),
      wallClock: () => new Date(),
      loggerFor: (correlationId) => createLogger({ correlationId, level: "warn", bindings: { service: "ui-server" } }),
      signup: () => signup,
      guest: () => ({ client: memory.client, connector: memory.connector, provisioner: { request: async () => undefined }, now: () => new Date() }),
    },
    ports,
  );
  const createContext = createContextFactory(() => deps);
  const api = createHTTPHandler({
    router: appRouter,
    basePath: `${API_PREFIX}/`,
    // Answers carry one world's data: nothing may keep them (routers/handler.ts does the same).
    responseMeta: () => ({ headers: { "cache-control": "no-store" } }),
    createContext: ({ req }) => createContext({ event: { headers: forwardedHeaders(req) }, edge: { viewerIp: req.socket.remoteAddress ?? "127.0.0.1", anonymousIp: false } }),
  });
  return {
    memory,
    ports,
    inbound,
    async handle(request, response) {
      if (await handleS3(ports.objects, request, response, options.origin)) return true;
      if (!request.url?.startsWith(`${API_PREFIX}/`)) return false;
      await api(request, response);
      return true;
    },
  };
}
