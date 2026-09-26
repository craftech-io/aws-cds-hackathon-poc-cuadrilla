// Root router of the console: one key per feature (docs/tool-catalog.md "Procedimientos de la
// consola"), each built from the procedures of ./trpc. The web client is typed against `AppRouter`;
// WP-40 registers the feature routers here.
//
// `createQaCaller` is how the `QaDriver` runs `console.*` actions (ADR-0007): the real router and
// middlewares, with a principal built on the server and bound to the world the action names.
import { type ContextDeps, defaultDeps } from "./deps";
import { healthRouter } from "./health";
import { type ServerCallOptions, createCallerFactory, createServerContext, router } from "./trpc";

export const appRouter = router({
  health: healthRouter,
});

export type AppRouter = typeof appRouter;

const createAppCaller = createCallerFactory(appRouter);

export type AppCaller = ReturnType<typeof createAppCaller>;

/** The console router as the `QaDriver`'s `SUPERVISOR`, `OPS` or `JUDGE` of one world. */
export function createQaCaller(options: ServerCallOptions, deps: ContextDeps = defaultDeps()): AppCaller {
  return createAppCaller(createServerContext(options, deps));
}
