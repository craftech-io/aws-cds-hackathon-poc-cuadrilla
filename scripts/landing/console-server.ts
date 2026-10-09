// One localhost origin that serves the console as the stage's Router does: the web from packages/web
// through Vite (the real sources, no build) and, under /api, the BFF's real `appRouter` in this
// process (and, for a world of the console's scenes, the S3 emulator of tests/ui-server/ under /s3).
// The capture pipeline (capture-console.ts) takes its pictures here, and the local UI server of the
// console's specs (tests/ui-server/) starts from it.
//
// The server plays the part of the Router and of routers/edge.ts for the requests it answers itself:
// it forwards the headers the BFF reads (authorization, correlation id) and hands tRPC the viewer's
// address as the edge would after the origin check, so the public signup counts this machine as its
// viewer. It listens on 127.0.0.1 only. The console is built with the pool ids of the world's token
// issuer, so it takes a planted session without asking Cognito for anything.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { createServer as createViteServer } from "vite";
import { API_PREFIX } from "../../packages/bff/src/routers/api-path";
import type { ContextDeps } from "../../packages/bff/src/routers/deps";
import { appRouter } from "../../packages/bff/src/routers/index";
import { createContextFactory } from "../../packages/bff/src/routers/trpc";

export interface ConsoleServer {
  readonly origin: string;
  close(): Promise<void>;
}

/** Answers what the Router would send to the BFF (`/api`, and `/s3` where an emulator stands in for S3); false hands the request to the web. */
export type ApiHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

export interface ConsoleServerOptions {
  /** packages/web. */
  readonly webDir: string;
  /** Read per request: each capture can bring a fresh world to the same server. */
  readonly handler: () => ApiHandler;
  /** Build variables of the console (packages/web/src/lib/env.ts): the world issuer's pool, never a real one. */
  readonly pool: { readonly userPoolId: string; readonly clientId: string; readonly signupClientId?: string };
  /** 0 (the default) takes any free port. */
  readonly port?: number;
}

/** The headers the Router forwards to the BFF and the BFF reads. */
const FORWARDED = ["authorization", "x-correlation-id"] as const;

function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

/** The BFF's real `appRouter` under `/api`, over `deps`, as the Router and routers/edge.ts hand it a request. */
export function apiHandler(deps: ContextDeps): ApiHandler {
  const createContext = createContextFactory(() => deps);
  const api = createHTTPHandler({
    router: appRouter,
    basePath: `${API_PREFIX}/`,
    // Answers carry one world's data: nothing may keep them (routers/handler.ts does the same).
    responseMeta: () => ({ headers: { "cache-control": "no-store" } }),
    createContext: ({ req }) =>
      createContext({ event: { headers: forwardedHeaders(req) }, edge: { viewerIp: req.socket.remoteAddress ?? "127.0.0.1", anonymousIp: false } }),
  });
  return async (req, res) => {
    if (!req.url?.startsWith(`${API_PREFIX}/`)) return false;
    await api(req, res);
    return true;
  };
}

export async function startConsoleServer(options: ConsoleServerOptions): Promise<ConsoleServer> {
  // Vite passes VITE_* variables of the process to the build (src/lib/env.ts reads them).
  // The signup form needs its own public client (`GuestSignup`); the capture's Cognito stand-in answers any.
  Object.assign(process.env, {
    VITE_COGNITO_USER_POOL_ID: options.pool.userPoolId,
    VITE_COGNITO_CLIENT_ID: options.pool.clientId,
    VITE_COGNITO_SIGNUP_CLIENT_ID: options.pool.signupClientId ?? `${options.pool.clientId}-signup`,
  });
  const vite = await createViteServer({
    configFile: join(options.webDir, "vite.config.ts"),
    root: options.webDir,
    logLevel: "warn",
    clearScreen: false,
    appType: "spa",
    server: { middlewareMode: true, hmr: false },
  });
  const server: Server = createHttpServer((req, res) => {
    options
      .handler()(req, res)
      .then((handled) => {
        if (!handled) vite.middlewares(req, res);
      })
      .catch((error: unknown) => {
        process.stderr.write(`console-server: ${error instanceof Error ? error.name : "error"} on ${req.method ?? "?"} ${req.url?.split("?")[0] ?? "?"}\n`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the console server has no TCP port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await vite.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
