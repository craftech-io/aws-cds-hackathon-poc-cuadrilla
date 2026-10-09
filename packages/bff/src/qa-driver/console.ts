// `console.*` of the `QaDriver` (docs/tool-catalog.md, ADR-0007): any procedure of the real `appRouter`
// with the real middlewares (fence by operator, roles, recent sign-in, the reset's limit), as a principal
// built on the server and bound to the world the call names: `SUPERVISOR` `usr-qa-sup` or `OPS`
// `usr-qa-ops` of a QA world, or `GUEST` `usr-qa-guest` of `GUEST#isp-guest-test` (`authTime` and
// `sessionId` configurable, so `SC-19` opens two sessions and `SC-13/2` signs in 20 minutes back). With
// `signupUser`, the principal is the one Cognito's id token of `auth.qaLogin` carries (post authentication
// and pre token ran for real), and only for that user's own guest world.
import { ToolError } from "@cuadrilla/shared";
import type { AppCaller } from "../routers/index";
import { QA_REASON } from "./contract";
import type { QaParsedInput } from "./contract-inputs";
import { PUBLIC_CONSOLE } from "./guard";
import type { QaPorts } from "./ports";
import { requireQaUser } from "./signup-fence";

type Procedure = (input?: unknown) => Promise<unknown>;

/** The procedure of `caller` at `path` (`clock.dispatch.reschedule` → `caller.clock.dispatch.reschedule`). */
export function procedureAt(caller: AppCaller, path: string): Procedure {
  let node: unknown = caller;
  for (const segment of path.split(".")) {
    node = node === undefined || node === null ? undefined : (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== "function") throw new ToolError("NOT_FOUND", `console.${path} is not a procedure of the console`);
  return node as Procedure;
}

export interface ConsoleCallOptions {
  readonly runId: string;
  readonly correlationId: string;
  /** Real time. */
  readonly now: Date;
}

async function signupCaller(ports: QaPorts, input: QaParsedInput<"console">, options: ConsoleCallOptions): Promise<AppCaller> {
  const seam = ports.signup();
  const username = input.signupUser ?? "";
  await requireQaUser(seam.cognito, username);
  const { idToken } = await seam.cognito.adminSignIn(username, seam.passwordOf(username));
  const principal = await ports.console.token(idToken, options.correlationId);
  if (principal.clockId !== input.clockId) throw new ToolError("FORBIDDEN", "the principal of auth.qaLogin acts only on its own guest world", QA_REASON.QA_FENCE);
  return principal.caller;
}

/** Runs one procedure; its refusal (a `TRPCError`) is mapped by the driver (driver.ts `failureOf`). */
export async function callConsole(ports: QaPorts, input: QaParsedInput<"console">, options: ConsoleCallOptions): Promise<unknown> {
  let caller: AppCaller;
  if (input.signupUser !== undefined) caller = await signupCaller(ports, input, options);
  else if (PUBLIC_CONSOLE.includes(input.procedure)) caller = ports.console.public(options.runId, options.correlationId);
  else {
    const authTime = Math.floor(options.now.getTime() / 1000) - input.authTimeAgoSec;
    caller = ports.console.server({ role: input.role, clockId: input.clockId, authTime, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), runId: options.runId, correlationId: options.correlationId });
  }
  return procedureAt(caller, input.procedure)(input.input);
}
