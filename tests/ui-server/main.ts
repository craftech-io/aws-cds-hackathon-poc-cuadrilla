// Entry of the local UI server the Playwright specs of the console start (docs/test-plan.md §2, level
// UI): Vite serves packages/web (the real sources, no build) and app.ts answers `/api` and `/s3` on the
// same origin. It listens on 127.0.0.1 only.
//
// The JWKS the BFF's real verifier trusts here is injected only from this entry (never from the Lambda
// handler, packages/bff/src/auth/no-jwks-override.test.ts): the public half of the run's ephemeral RSA
// key, which the Playwright config creates in its main process (packages/web/e2e/support/tokens.ts) and
// hands down in `E2E_ID_TOKEN_PRIVATE_KEY`. Its `kid` is derived the same way. No key is written to disk.
//
//   E2E_UI_SERVER_PORT           port (4174 by default)
//   VITE_COGNITO_USER_POOL_ID    the placeholder pool of the build (also the issuer the tokens carry)
//   VITE_COGNITO_CLIENT_ID       the console's client; the fake pool's own audience is accepted too
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import { createUiApp } from "./app";

const DEFAULT_PORT = 4174;
/** The audience of the fake user pool's tokens (packages/web/src/lib/auth/testing/fake-cognito.ts). */
const FAKE_POOL_AUDIENCE = "fake-client";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`the UI server needs ${name} (set by the Playwright config)`);
  return value;
}

/** The public JWK of the run's key, with the `kid` the specs sign with. */
export function runJwks(privateKeyPem: string): { readonly keys: readonly unknown[] } {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem));
  const kid = `e2e-${createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16)}`;
  return { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] };
}

async function main(): Promise<void> {
  const port = Number(process.env.E2E_UI_SERVER_PORT ?? DEFAULT_PORT);
  const origin = `http://127.0.0.1:${port}`;
  const userPoolId = required("VITE_COGNITO_USER_POOL_ID");
  const clientId = required("VITE_COGNITO_CLIENT_ID");
  const app = await createUiApp({ origin, pool: { userPoolId, clientIds: [clientId, FAKE_POOL_AUDIENCE] }, jwks: runJwks(required("E2E_ID_TOKEN_PRIVATE_KEY")) });
  const webDir = join(import.meta.dirname, "../../packages/web");
  const vite = await createViteServer({ root: webDir, configFile: join(webDir, "vite.config.ts"), logLevel: "warn", clearScreen: false, appType: "spa", server: { middlewareMode: true, hmr: false } });
  const server = createServer((request, response) => {
    app
      .handle(request, response)
      .then((handled) => {
        if (!handled) vite.middlewares(request, response);
      })
      .catch((error: unknown) => {
        process.stderr.write(`ui-server: ${error instanceof Error ? error.name : "error"} on ${request.method ?? "?"} ${request.url?.split("?")[0] ?? "?"}\n`);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  });
  server.listen(port, "127.0.0.1", () => process.stdout.write(`ui-server: ${origin}\n`));
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) void main();
