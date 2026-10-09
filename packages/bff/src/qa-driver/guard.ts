// The fence of the `QaDriver` (ADR-0007, docs/tool-catalog.md "Acciones del QaDriver", docs/test-plan.md
// §4.1). Before an action runs, the guard resolves the world it touches from ids it reads itself (an
// order's, a person's, a case's or a timer's own `clockId`, never the clock the input pairs it with) and
// checks, before a byte is written:
//
//   qa-*                    every action
//   eval-*                  world.create, world.destroy, eval.*, tool.invoke, snapshot, installer.settle,
//                           world.settle, metrics.get
//   GUEST#isp-guest-test    world.create({template: guest}), world.destroy, snapshot, installer.settle,
//                           world.settle and `console.*` with the `GUEST` principal on its closed list
//   own sign-up accounts    the seam (auth.*, guest.forceExpire, leads.get and `console.*`
//                           with the principal of `auth.qaLogin`): fenced by the address Cognito holds for
//                           the user (signup-fence.ts), checked by the action itself after `AdminGetUser`
//   no world                the probes of the stage (mocks, KB, WAF, the pool, G1), the foreign event and
//                           the run's own test caps (`…#qa-<runId>#…`)
//   anything else           FORBIDDEN
//
// A changing action also needs the world's stored operator to be of type `QA` or `EVAL` (or the test
// guest's own); a row the input names that belongs to another world is FORBIDDEN, whatever it is.
import { GUEST_TEST_CLOCK_ID, type IspKind, ToolError, parseClockId } from "@cuadrilla/shared";
import { parseTimerRefKey } from "../connector/keys";
import { QA_REASON, type QaActionName, READ_ONLY_ACTIONS } from "./contract";
import { GuestTestCreate, type QaParsedInput } from "./contract-inputs";

/** Actions an evaluation world admits. */
export const EVAL_ACTIONS: ReadonlySet<string> = new Set(["world.create", "world.destroy", "eval.runQuestions", "eval.runPhotos", "tool.invoke", "snapshot", "installer.settle", "world.settle", "metrics.get"]);

/**
 * Actions of the test guest's world besides `console.*` (`world.create` only with `{template: guest}`). The two
 * reads `policyAudit.run` and `metrics.get` let the runner audit every world of a run (docs/test-plan.md §1
 * item 5), this one included.
 */
export const GUEST_TEST_ACTIONS: ReadonlySet<string> = new Set(["world.create", "world.destroy", "snapshot", "installer.settle", "world.settle", "policyAudit.run", "metrics.get"]);

/**
 * `console.*` procedures the `GUEST` principal may run on `GUEST#isp-guest-test` (by router, or exactly).
 * `manual.*` and `tour.steps` are reads the tour needs (`SC-18/6`, the steps of `console.tour.run`).
 */
export const GUEST_TEST_CONSOLE: readonly string[] = ["tour.run", "tour.steps", "clock.", "simulator.", "orders.", "cases.", "evidence.", "metrics.", "manual.", "account.session"];

/** Public procedures without any world's data: a console call to them names no world. */
export const PUBLIC_CONSOLE: readonly string[] = ["brand.get", "health.live"];

/** Actions that touch no world (the stage's probes) or only the run's own test keys. */
export const WORLDLESS_ACTIONS: ReadonlySet<QaActionName> = new Set<QaActionName>([
  "probe.mocks",
  "waf.probe",
  "auth.probe",
  "guardrail.probe",
  "alarm.history",
  // A computation over the addresses and the world's kind: it reads no row of any world (the demo's too, FL-076).
  "fence.probe",
  "wa.publishForeign",
  "probe.foreign",
  "guest.capsOverride",
]);

/** The seam of the own sign-up: fenced by the address Cognito holds for the `gst-*` user. */
export const SIGNUP_ACTIONS: ReadonlySet<QaActionName> = new Set<QaActionName>(["auth.signUp", "auth.confirmQaSignup", "auth.qaLogin", "auth.cleanupQaSignup", "guest.forceExpire", "leads.get"]);

export type ScopeFamily = "WORLD" | "WORLDLESS" | "SIGNUP";

/** What an action touches, resolved by the guard from stored data. */
export interface Scope {
  /** The action, or `console.<procedure>`. */
  readonly name: string;
  readonly family: ScopeFamily;
  /** The world of a `WORLD` scope. */
  readonly clockId?: string;
  /** Whether the call changes something. */
  readonly mutating: boolean;
  /** A console call: its role and whether it acts as the `gst-*` user of `auth.qaLogin`. */
  readonly console?: { readonly procedure: string; readonly role: string; readonly signupUser?: string };
}

/** Where a row the input names lives (`undefined` when it does not exist). */
export interface GuardLookups {
  ispKindOf(ispId: string): Promise<IspKind | undefined>;
  clockOfWorkOrder(workOrderId: string): Promise<string | undefined>;
  clockOfPerson(personId: string): Promise<string | undefined>;
  clockOfCase(caseId: string): Promise<string | undefined>;
  clockOfTimer(timerKey: string): Promise<string | undefined>;
  /** Whether a console procedure is a query (only queries of public procedures are worldless). */
  procedureKind(procedure: string): "query" | "mutation" | undefined;
}

export function forbidden(message: string): ToolError {
  return new ToolError("FORBIDDEN", message, QA_REASON.QA_FENCE);
}

function startsWithAny(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => (prefix.endsWith(".") ? name.startsWith(prefix) : name === prefix));
}

/** The fence over a resolved scope and the world's stored operator kind (pure: guard.test.ts drives it). */
export function checkFence(scope: Scope, storedKind: IspKind | undefined): void {
  if (scope.family === "WORLDLESS" || scope.family === "SIGNUP") return;
  const clockId = scope.clockId;
  if (clockId === undefined) throw forbidden(`${scope.name} needs a world`);
  const parsed = parseClockId(clockId);
  if (parsed === undefined) throw new ToolError("INVALID", `invalid clock id "${clockId}"`);
  if (clockId === GUEST_TEST_CLOCK_ID) {
    if (scope.console !== undefined) {
      if (scope.console.role !== "GUEST") throw forbidden(`only the GUEST principal acts on ${clockId}`);
      if (!startsWithAny(scope.console.procedure, GUEST_TEST_CONSOLE)) throw forbidden(`${scope.name} is not on the closed list of ${clockId}`);
    } else if (!GUEST_TEST_ACTIONS.has(scope.name)) throw forbidden(`${scope.name} is not on the closed list of ${clockId}`);
    if (storedKind !== undefined && storedKind !== "GUEST") throw forbidden(`the operator of ${clockId} is not the test guest's`);
    return;
  }
  if (parsed.kind === "EVAL") {
    if (!EVAL_ACTIONS.has(scope.name)) throw forbidden(`${scope.name} is not allowed on an evaluation world`);
  } else if (parsed.kind !== "QA") {
    throw forbidden(`the QA driver never acts on ${parsed.kind.toLowerCase()} worlds (${scope.name})`);
  }
  if (scope.console?.signupUser !== undefined) throw forbidden("the principal of auth.qaLogin acts only on its own guest world");
  if (scope.mutating && storedKind !== undefined && storedKind !== "QA" && storedKind !== "EVAL") throw forbidden(`the operator of ${clockId} is not of type QA or EVAL`);
}

// ---- Resolving the world of an input ----------------------------------------------------------------

type Named = Readonly<Record<string, unknown>>;

async function sameWorld(found: string | undefined, what: string, clockId: string | undefined): Promise<string> {
  if (found === undefined) throw new ToolError("NOT_FOUND", `${what} does not exist`);
  if (clockId !== undefined && found !== clockId) throw forbidden(`${what} is not of ${clockId}`);
  return found;
}

/** Every row the input names, each resolved to its own world; all must be of one world. */
async function worldOfIds(input: Named, lookups: GuardLookups, named: string | undefined): Promise<string | undefined> {
  let clockId = named;
  const pin = async (value: unknown, what: string, read: (id: string) => Promise<string | undefined>): Promise<void> => {
    if (typeof value !== "string") return;
    clockId = await sameWorld(await read(value), `${what} ${value}`, clockId);
  };
  await pin(input.workOrderId, "work order", lookups.clockOfWorkOrder);
  await pin(input.installerId, "installer", lookups.clockOfPerson);
  await pin(input.personId, "person", lookups.clockOfPerson);
  await pin(input.newInstallerId, "installer", lookups.clockOfPerson);
  await pin(input.caseId, "case", lookups.clockOfCase);
  if (typeof input.timerKey === "string") {
    if (parseTimerRefKey(input.timerKey) === undefined) throw new ToolError("INVALID", "not a timer key");
    await pin(input.timerKey, "timer", lookups.clockOfTimer);
  }
  if (typeof input.identity === "string" && input.identity !== "UNKNOWN") await pin(input.identity, "identity", lookups.clockOfPerson);
  if (typeof (input.content as Named | undefined)?.fromPersonId === "string") await pin((input.content as Named).fromPersonId, "person", lookups.clockOfPerson);
  for (const list of ["workOrderIds", "personIds", "caseIds"] as const) {
    const read = list === "workOrderIds" ? lookups.clockOfWorkOrder : list === "personIds" ? lookups.clockOfPerson : lookups.clockOfCase;
    for (const value of (input[list] as unknown[] | undefined) ?? []) await pin(value, list.slice(0, -1), read);
  }
  return clockId;
}

function consoleScope(input: QaParsedInput<"console">, lookups: GuardLookups): Scope {
  const name = `console.${input.procedure}`;
  const kind = lookups.procedureKind(input.procedure);
  if (kind === undefined) throw new ToolError("NOT_FOUND", `${name} is not a procedure of the console`);
  const console = { procedure: input.procedure, role: input.role, ...(input.signupUser === undefined ? {} : { signupUser: input.signupUser }) };
  if (input.signupUser !== undefined) return { name, family: "SIGNUP", clockId: input.clockId, mutating: kind === "mutation", console };
  return { name, family: "WORLD", clockId: input.clockId, mutating: kind === "mutation", console };
}

/** Resolves what `action` touches from its parsed input and stored rows. */
export async function resolveScope(action: QaActionName, raw: unknown, lookups: GuardLookups): Promise<Scope> {
  const mutating = !READ_ONLY_ACTIONS.has(action);
  if (WORLDLESS_ACTIONS.has(action)) return { name: action, family: "WORLDLESS", mutating };
  if (SIGNUP_ACTIONS.has(action)) return { name: action, family: "SIGNUP", mutating };
  if (action === "console") {
    const call = raw as QaParsedInput<"console">;
    if (PUBLIC_CONSOLE.includes(call.procedure) && call.signupUser === undefined) return { name: `console.${call.procedure}`, family: "WORLDLESS", mutating: false };
    return consoleScope(call, lookups);
  }
  const input = (raw ?? {}) as Named;
  if (action === "world.create") {
    const clockId = typeof input.clockId === "string" ? input.clockId : undefined;
    if (clockId === undefined) throw new ToolError("INVALID", "world.create names its world (clockId)");
    if (clockId === GUEST_TEST_CLOCK_ID && !GuestTestCreate.safeParse(raw).success) throw forbidden(`world.create of ${clockId} is only {template: guest}`);
    return { name: action, family: "WORLD", clockId, mutating };
  }
  if (action === "eval.runQuestions" || action === "eval.runPhotos") {
    const clockId = typeof input.clockId === "string" ? input.clockId : undefined;
    if (clockId === undefined) throw new ToolError("INVALID", `${action} names its world (clockId)`);
    return { name: action, family: "WORLD", clockId, mutating };
  }
  const clockId = await worldOfIds(input, lookups, typeof input.clockId === "string" ? input.clockId : undefined);
  if (clockId === undefined) throw new ToolError("INVALID", `${action} names no world`);
  return { name: action, family: "WORLD", clockId, mutating };
}

/** Resolves and checks: the scope an action may run with, or FORBIDDEN. */
export async function guard(action: QaActionName, input: unknown, lookups: GuardLookups): Promise<Scope> {
  const scope = await resolveScope(action, input, lookups);
  const parsed = scope.clockId === undefined ? undefined : parseClockId(scope.clockId);
  const storedKind = scope.family === "WORLD" && parsed !== undefined ? await lookups.ispKindOf(parsed.ispId) : undefined;
  checkFence(scope, storedKind);
  return scope;
}
