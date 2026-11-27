/// <reference path="../../sst-env.d.ts" />
// `phone` router of the console (ADR-0029, docs/tool-catalog.md): the SMS code, second factor of every
// Cognito session. Every procedure is `ispProcedure` and acts only on the principal's own account and
// session: nothing of the input names a user, an operator or a session. These and `account.session` are
// the only procedures a session answers before it passed its code (routers/trpc.ts).
//
//   status       PASSED | ENROL | SIGN_IN, the number to prefill (ENROL) or its last digits (SIGN_IN),
//                whether a code is out, its expiry and when another one may be asked for
//   sendCode     { locale, phone? }: the number only at an enrolment (a sign-in refuses it, PHONE_LOCKED)
//   verifyCode   { code }: six digits; on success the session is passed
//   carrySession { previousIdToken }: the password asked again inside a passed session (ADR-0011's recent
//                sign-in) keeps the pass for the new session of the same user, never for another one
//   endSession   the sign-out deletes the session's mark (the web calls it before `RevokeToken`)
import { z } from "zod";
import { LegalLocale } from "@cuadrilla/shared/legal/consents";
import { ToolError } from "@cuadrilla/shared";
import { bearerToken } from "../auth/jwt";
import { principalFromClaims } from "../auth/principal";
import { type PhoneCaller, type PhonePorts, carryPhoneSession, endPhoneSession, phoneStatusOf, sendPhoneCode, verifyPhoneCode } from "../phone/flow";
import { defaultPhonePorts } from "../phone/ports";
import { type IspContext, ispProcedure, router } from "./trpc";

export const PhoneStatusView = z.object({
  state: z.enum(["PASSED", "ENROL", "SIGN_IN"]),
  phone: z.string().optional(),
  maskedPhone: z.string().optional(),
  codeSent: z.boolean(),
  codeExpiresAt: z.string().optional(),
  resendAt: z.string().optional(),
});

const NoInput = z.object({}).strict().optional();
const SendInput = z.object({ locale: LegalLocale, phone: z.string().max(32).optional() }).strict();
const VerifyInput = z.object({ code: z.string().max(12) }).strict();
const CarryInput = z.object({ previousIdToken: z.string().min(1).max(8_192) }).strict();

const callerOf = (ctx: IspContext): PhoneCaller => ({ principal: ctx.principal, viewerIp: ctx.edge?.viewerIp, log: ctx.log });

/** `ports` for a test; otherwise the context's (a local server) or the Lambda's own, from its links. */
export function createPhoneRouter(ports?: () => PhonePorts) {
  const portsOf = (ctx: IspContext): PhonePorts => (ports ?? ctx.deps.phone ?? (() => defaultPhonePorts(ctx.deps.phoneGate)))();
  return router({
    status: ispProcedure
      .input(NoInput)
      .output(PhoneStatusView)
      .query(({ ctx }) => phoneStatusOf(portsOf(ctx), callerOf(ctx))),
    sendCode: ispProcedure
      .input(SendInput)
      .output(PhoneStatusView)
      .mutation(({ ctx, input }) => sendPhoneCode(portsOf(ctx), callerOf(ctx), input)),
    verifyCode: ispProcedure
      .input(VerifyInput)
      .output(PhoneStatusView)
      .mutation(({ ctx, input }) => verifyPhoneCode(portsOf(ctx), callerOf(ctx), input.code.trim())),
    carrySession: ispProcedure
      .input(CarryInput)
      .output(PhoneStatusView)
      .mutation(async ({ ctx, input }) => {
        let previous;
        try {
          previous = principalFromClaims(await ctx.deps.verifier.verify(bearerToken(`Bearer ${input.previousIdToken}`)));
        } catch {
          throw new ToolError("FORBIDDEN", "enter the code sent to your phone to continue", "SESSION_NOT_CARRIED");
        }
        return carryPhoneSession(portsOf(ctx), callerOf(ctx), previous);
      }),
    endSession: ispProcedure
      .input(NoInput)
      .output(z.object({ ended: z.literal(true) }))
      .mutation(({ ctx }) => endPhoneSession(portsOf(ctx), callerOf(ctx))),
  });
}

export const phoneRouter = createPhoneRouter();
