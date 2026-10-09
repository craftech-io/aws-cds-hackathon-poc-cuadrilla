/// <reference path="../../sst-env.d.ts" />
// `account` router of the console (docs/tool-catalog.md, "Procedimientos de la consola"): the session of
// the principal and what it may do with its own account (ADR-0024, ADR-0025 §6, ADR-0026).
//
//   session          who is signed in and what the shell offers: for a GUEST, "one session per world"
//                    (`Runtime/CLOCK#.lastSession`): a session that finds another one active in the last
//                    30 real minutes gets the notice and no "Reiniciar demo"; otherwise it becomes the
//                    world's session. Staff never share a world's session.
//   changePassword   staff only: the console asks before it calls Cognito's `ChangePassword` with the
//                    user's own access token (the password never reaches the BFF); a GUEST gets 403
//   mfa.setup        staff only, the same for associating a TOTP; a GUEST gets 403
//   deleteGuest      G R: a GUEST with an interactive sign-in at most 15 minutes old, and only a guest of
//                    the own sign-up (operator `isp-guest-s…`, user `usr-g<ULID>`): an INVITED or TEST
//                    guest, a supervisor or an operator gets 403. It invokes `GuestAccountDeletion` with
//                    `{userId}` OF THE PRINCIPAL and nothing else: whatever the input says (another id, an
//                    email) never reaches the payload. The function checks the target again on its side.
//                    The web signs out right after (`RevokeToken`).
//
// Nothing here returns a lead or an email (routers/public-surface.test.ts).
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import type { Principal } from "../auth/principal";
import { DeletionResult } from "../leads/deletion";
import { SIGNUP_USER_ID_PATTERN } from "../leads/model";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { actorOf } from "./console-ports";
import { refusal } from "./errors";
import { type IspContext, ispProcedure, recentLoginProcedure, router } from "./trpc";

/** Operator of a generation of the own sign-up (ADR-0025 §2): `isp-guest-s<yymmdd><5 base32>`. */
export const SIGNUP_GENERATION_ISP = /^isp-guest-s\d{6}[a-z2-7]{5}$/;

export interface AccountPorts {
  /** Synchronous invocation of `GuestAccountDeletion` with exactly this payload. */
  deleteGuestAccount(payload: { readonly userId: string }): Promise<DeletionResult>;
}

/** A guest of the own sign-up, by what the token stamped (the function re-checks the registry). */
export function isSignupGuest(principal: Pick<Principal, "role" | "isGuest" | "ispId" | "userId">): boolean {
  return principal.role === "GUEST" && principal.isGuest && SIGNUP_GENERATION_ISP.test(principal.ispId) && SIGNUP_USER_ID_PATTERN.test(principal.userId);
}

/** The core of `account.deleteGuest`, after the G R middlewares. */
export async function deleteGuestOf(principal: Pick<Principal, "role" | "isGuest" | "ispId" | "userId">, ports: AccountPorts): Promise<{ readonly deleted: true }> {
  if (principal.role !== "GUEST") throw refusal("FORBIDDEN", "only a guest can delete its own account here", "ROLE_NOT_ALLOWED");
  if (!isSignupGuest(principal)) throw refusal("FORBIDDEN", "this account was not created by sign-up and cannot be deleted here", "NOT_A_SIGNUP_GUEST");
  const answer = await ports.deleteGuestAccount({ userId: principal.userId });
  if (answer.outcome === "REFUSED") throw refusal("FORBIDDEN", "this account cannot be deleted here", "NOT_A_SIGNUP_GUEST");
  return { deleted: true };
}

// ---- Default port: the linked Function ------------------------------------------------------------

const LinkedFunction = z.object({ name: z.string().min(1) });
let lambda: LambdaClient | undefined;

export function lambdaAccountPorts(client?: Pick<LambdaClient, "send">, functionName: () => string = () => readLinked("GuestAccountDeletion", LinkedFunction).name): AccountPorts {
  return {
    async deleteGuestAccount(payload) {
      const sender = client ?? (lambda ??= new LambdaClient(awsClientConfig(CLIENT_TIMEOUTS.lambda)));
      const output = await sender.send(new InvokeCommand({ FunctionName: functionName(), InvocationType: "RequestResponse", Payload: new TextEncoder().encode(JSON.stringify({ userId: payload.userId })) }));
      if (output.FunctionError !== undefined || output.Payload === undefined) throw refusal("UNAVAILABLE", "the account could not be deleted right now");
      const answer = DeletionResult.safeParse(JSON.parse(new TextDecoder().decode(output.Payload)));
      if (!answer.success) throw refusal("UNAVAILABLE", "the account could not be deleted right now");
      return answer.data;
    },
  };
}

// ---- Session and staff-only actions --------------------------------------------------------------

/** A guest's session is the world's while it acted in the last 30 real minutes. */
export const SESSION_ACTIVE_MS = 30 * 60_000;

type SessionCtx = Pick<IspContext, "deps" | "world" | "principal" | "log">;

async function claimSession(ctx: SessionCtx): Promise<boolean> {
  const runtime = ctx.deps.connector.runtime;
  const clock = await runtime.getClock(ctx.world.clockId);
  if (clock === undefined) return false;
  const now = ctx.deps.wallClock();
  const last = clock.lastSession;
  const other = last !== undefined && last.sessionId !== ctx.principal.sessionId && now.getTime() - Date.parse(last.atReal) < SESSION_ACTIVE_MS;
  if (other) return true;
  try {
    await runtime.updateClock(clock.clockId, { lastSession: { userId: ctx.principal.userId, sessionId: ctx.principal.sessionId, atReal: now.toISOString() } }, clock.version);
  } catch (error) {
    // A concurrent move of the clock wins; this session is recorded on its next call.
    ctx.log.warn("account.session.not_recorded", { reason: error instanceof Error ? error.name : "unknown" });
  }
  return false;
}

export async function sessionOf(ctx: SessionCtx) {
  const { principal } = ctx;
  const otherSession = principal.role === "GUEST" ? await claimSession(ctx) : false;
  const acts = principal.role === "SUPERVISOR" || principal.role === "GUEST";
  return {
    userId: principal.userId,
    role: principal.role,
    isGuest: principal.isGuest,
    clockId: principal.clockId,
    otherSession,
    canReset: acts && !otherSession,
    canChangePassword: principal.role !== "GUEST",
    canSetupMfa: principal.role !== "GUEST",
    canDeleteAccount: isSignupGuest(principal),
  };
}

async function staffOnly(ctx: SessionCtx, action: "PASSWORD_CHANGE_REQUESTED" | "MFA_SETUP_REQUESTED") {
  if (ctx.principal.role === "GUEST") throw refusal("FORBIDDEN", "a guest account keeps the password and the sign-in it was given", "GUEST_ACCOUNT");
  const atSim = (await ctx.world.clock.now()).toISOString();
  await ctx.deps.connector.audit.append({ ispId: ctx.world.ispId, clockId: ctx.world.clockId, atSim, decision: "ACTION", action, actor: actorOf(ctx.principal) });
  return { allowed: true as const };
}

export function createAccountRouter(ports: () => AccountPorts) {
  return router({
    session: ispProcedure.query(({ ctx }) => sessionOf(ctx)),
    changePassword: ispProcedure.mutation(({ ctx }) => staffOnly(ctx, "PASSWORD_CHANGE_REQUESTED")),
    mfa: router({ setup: ispProcedure.mutation(({ ctx }) => staffOnly(ctx, "MFA_SETUP_REQUESTED")) }),
    // No input is read: the target is the principal, whatever the request carries.
    deleteGuest: recentLoginProcedure.input(z.record(z.string(), z.unknown()).optional()).mutation(async ({ ctx }) => {
      const result = await deleteGuestOf(ctx.principal, ports());
      ctx.log.info("account.guest.deleted", { userId: ctx.principal.userId });
      return result;
    }),
  });
}

export const accountRouter = createAccountRouter(() => lambdaAccountPorts());
