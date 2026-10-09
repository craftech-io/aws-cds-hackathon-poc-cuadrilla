// Root router of the console: one key per feature (docs/tool-catalog.md "Procedimientos de la
// consola"), each built from the procedures of ./trpc. The web client is typed against `AppRouter`.
// Public, without any world's data: `health.live`, `brand.get` and `signup.start` (the own sign-up,
// ADR-0025); everything else needs a principal of an operator (`ispProcedure` and its narrower ones).
//
// `createQaCaller` is how the `QaDriver` runs `console.*` actions (ADR-0007): the real router and
// middlewares, with a principal built on the server and bound to the world the action names.
import { accountRouter } from "./account";
import { auditRouter } from "./audit";
import { brandRouter } from "./brand";
import { casesRouter } from "./cases";
import { clockRouter } from "./clock";
import { type ContextDeps, defaultDeps } from "./deps";
import { evidenceRouter } from "./evidence";
import { guestRouter } from "./guest";
import { healthRouter } from "./health";
import { manualRouter } from "./manual";
import { metricsRouter } from "./metrics";
import { ordersRouter } from "./orders";
import { outboxRouter } from "./outbox";
import { peopleRouter } from "./people";
import { signupRouter } from "./signup";
import { simulatorRouter } from "./simulator";
import { tourRouter } from "./tour";
import { type ServerCallOptions, createCallerFactory, createServerContext, router } from "./trpc";

export const appRouter = router({
  health: healthRouter,
  brand: brandRouter,
  signup: signupRouter,
  guest: guestRouter,
  account: accountRouter,
  orders: ordersRouter,
  cases: casesRouter,
  evidence: evidenceRouter,
  people: peopleRouter,
  clock: clockRouter,
  simulator: simulatorRouter,
  outbox: outboxRouter,
  manual: manualRouter,
  metrics: metricsRouter,
  audit: auditRouter,
  tour: tourRouter,
});

export type AppRouter = typeof appRouter;

const createAppCaller = createCallerFactory(appRouter);

export type AppCaller = ReturnType<typeof createAppCaller>;

/** The console router as the `QaDriver`'s `SUPERVISOR`, `OPS` or `GUEST` of one world. */
export function createQaCaller(options: ServerCallOptions, deps: ContextDeps = defaultDeps()): AppCaller {
  return createAppCaller(createServerContext(options, deps));
}
