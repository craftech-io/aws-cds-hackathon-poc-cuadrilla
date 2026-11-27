// The back half of the local UI server (docs/test-plan.md §2 and §3, level UI), on the base of
// scripts/landing/console-server.ts: the real `appRouter` behind `/api` and the S3 emulator behind `/s3`,
// on the same origin as the page, over one in-memory world (world.ts). The console's ports are the
// memory ones of the router tests (packages/bff/src/routers/console-testing.ts) with this server's
// origin for the presigned links, the repository's seed files as the buckets' content, the real world
// factory behind "Reiniciar demo" and "Saltar a escena" (worlds.ts) and the real `InboundWhatsApp` in
// process for the phone simulator (inbound.ts). The own sign-up (`signup.start`
// over memory), the guest's portada (`guest.*`), the account (`account.*`) and the SMS code (`phone.*`,
// with the in-memory SMS sender: nothing is texted) answer as in the stage.
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
import type { ConsolePorts } from "../../packages/bff/src/routers/console-ports";
import type { ContextDeps } from "../../packages/bff/src/routers/deps";
import { appRouter } from "../../packages/bff/src/routers/index";
import { createContextFactory } from "../../packages/bff/src/routers/trpc";
import { bearerToken } from "../../packages/bff/src/auth/jwt";
import { principalFromClaims } from "../../packages/bff/src/auth/principal";
import { markSessionPassed } from "../../packages/bff/src/phone/session";
import { type MemoryPhone, memoryPhone } from "../../packages/bff/src/phone/testing";
import { memorySignupPorts } from "../../packages/bff/src/signup/testing";
import { stampingVerifier } from "./identity";
import { type LocalInbound, UI_SIM_ENVELOPE_KEY, createLocalInbound } from "./inbound";
import { handleS3 } from "./s3-emulator";
import { UI_PHONE_HASH_KEY, createUiWorld, repositoryObject, uiPhoneHash } from "./world";
import { type UiWorlds, createUiWorlds } from "./worlds";

export interface UiAppOptions {
  /** `http://127.0.0.1:<port>`: the page, the API and the emulator share it. */
  readonly origin: string;
  /** The placeholder pool of the Vite build and the audiences its tokens may carry. */
  readonly pool: { readonly userPoolId: string; readonly clientIds: readonly string[] };
  /** Public half of the Playwright run's key. */
  readonly jwks: { readonly keys: readonly unknown[] };
}

/** The memory ports with the real world factory in place of the recording one. */
export type UiPorts = Omit<MemoryConsolePorts, "rebuild"> & Pick<ConsolePorts, "rebuild">;

export interface UiApp {
  readonly memory: MemoryConnector;
  readonly ports: UiPorts;
  readonly worlds: UiWorlds["worlds"];
  /** The router's dependencies, bound to these ports (the server's own tests call the router with them). */
  readonly deps: ContextDeps;
  readonly inbound: LocalInbound;
  /** The SMS code over memory (ADR-0029): the specs read the code of the last SMS from here. */
  readonly phone: MemoryPhone;
  /** Answers `/api` and `/s3`; false for anything else (the caller hands it to Vite). */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

/**
 * Test-only seam of this server (never of the Lambda): the session of a verified id token is marked as
 * passed, the mark a right SMS code leaves (packages/bff/src/phone/session.ts), so the specs of the views
 * skip the code's screen. The screen and the gate have their own specs.
 */
export const E2E_PHONE_PASS = `${API_PREFIX}/__e2e/phone/pass`;

async function passSession(deps: ContextDeps, authorization: string | undefined): Promise<boolean> {
  try {
    const principal = principalFromClaims(await deps.verifier.verify(bearerToken(authorization)));
    const phone = deps.phone?.();
    if (phone === undefined) return false;
    await markSessionPassed(phone.client, { userId: principal.userId, sessionId: principal.sessionId, authTime: principal.authTime }, new Date());
    return true;
  } catch {
    return false;
  }
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
  const factory = createUiWorlds(memory, base.objects);
  const ports: UiPorts = { ...base, rebuild: factory.rebuild, simEnvelopeKey: () => UI_SIM_ENVELOPE_KEY };
  const fetcher = staticJwksFetcher(options.jwks);
  const verifiers = options.pool.clientIds.map((clientId) => createCognitoIdTokenVerifier({ userPoolId: options.pool.userPoolId, clientId } satisfies IdTokenVerifierConfig, { fetcher }));
  const signup = memorySignupPorts();
  const phone = memoryPhone({ client: memory.client });
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
      phoneGate: phone.gate,
      phone: () => phone.ports,
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
    worlds: factory.worlds,
    deps,
    inbound,
    phone,
    async handle(request, response) {
      if (await handleS3(ports.objects, request, response, options.origin)) return true;
      if (request.url === E2E_PHONE_PASS && request.method === "POST") {
        response.writeHead((await passSession(deps, request.headers.authorization)) ? 204 : 401);
        response.end();
        return true;
      }
      if (!request.url?.startsWith(`${API_PREFIX}/`)) return false;
      await api(request, response);
      return true;
    },
  };
}
