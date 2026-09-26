// Health of the console BFF (docs/tool-catalog.md, "Procedimientos de la consola").
//
//   live   public liveness of the Router and of the smoke checks (`GET /api/health` is its alias,
//          routers/api-path.ts): no principal, no data of any world
//   ping   for a signed-in user: the BFF reaches both simulated systems with its own role
//          (`GET /v1/health` of `NetworkMock` and `DispatchMock`, SigV4); never fails, it reports
import { ispProcedure, publicProcedure, router } from "./trpc";

export const healthRouter = router({
  live: publicProcedure.query(() => ({ ok: true as const, service: "bff" as const })),
  ping: ispProcedure.query(async ({ ctx }) => {
    const mocks = await ctx.deps.mocks(ctx.log);
    return { ok: mocks.network === "OK" && mocks.dispatch === "OK", service: "bff" as const, mocks };
  }),
});
