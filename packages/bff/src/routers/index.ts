// Root router of the console: one key per feature (docs/tool-catalog.md "Procedimientos de la
// consola"), each built from the procedures of ./trpc, plus the public health probe the Router and
// the interim smoke check (`GET /api/health`). The web client is typed against `AppRouter`; WP-40
// registers the feature routers here.
import { publicProcedure, router } from "./trpc";

export const appRouter = router({
  /** No principal, no data: only says the function answers. */
  health: publicProcedure.query(() => ({ ok: true as const, service: "bff" as const })),
});

export type AppRouter = typeof appRouter;
