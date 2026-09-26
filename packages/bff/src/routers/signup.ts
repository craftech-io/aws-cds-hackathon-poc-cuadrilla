// `signup` router of the console (ADR-0025 §3): the own sign-up's one public procedure.
//
//   start   public MUTATION (a GET never runs it), served only as a single call: the edge
//           (routers/edge.ts) refuses any batch, encoded path or method that names `signup.` before
//           tRPC runs. It takes the form (never the password) and answers `{ticket, username,
//           expiresAt}`; never the lead, never an email (routers/public-surface.test.ts).
//
// The input is read as `unknown` and parsed inside (signup/form.ts), so a refusal carries only the codes
// and the names of the failing fields: never the request's values, never zod's messages.
import { z } from "zod";
import { defaultSignupPorts } from "../signup/ports";
import { type SignupPorts, startSignup } from "../signup/start";
import { publicProcedure, router } from "./trpc";

export const SignupStartOutput = z.object({ ticket: z.string().min(1), username: z.string().min(1), expiresAt: z.iso.datetime() });

/** `ports` for a test; otherwise the context's (a local server) or the Lambda's own, from its links. */
export function createSignupRouter(ports?: () => SignupPorts) {
  return router({
    start: publicProcedure
      .input(z.unknown())
      .output(SignupStartOutput)
      .mutation(({ ctx, input }) => startSignup(ports ?? ctx.deps.signup ?? defaultSignupPorts, { input, edge: ctx.edge, qa: ctx.qa, log: ctx.log })),
  });
}

export const signupRouter = createSignupRouter();
