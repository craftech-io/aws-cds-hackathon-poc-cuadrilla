/// <reference path="../../sst-env.d.ts" />
// Cognito custom message trigger (ADR-0025 §1 and §4, infra/auth.ts `AuthCustomMessage`): writes the
// authentication emails with the neutral texts of copy/auth-emails*.ts, in the language of the user's
// `locale` attribute (Mexican Spanish by default).
//
//   CustomMessage_SignUp, _ResendCode       the sign-up code; NOTHING is sent while the sign-up is cut
//                                           (KILL#SIGNUP or KILL#ALL): the trigger throws and Cognito
//                                           sends no email
//   CustomMessage_ForgotPassword            the recovery code, cut or not (sign-in and recovery go on)
//   CustomMessage_AdminCreateUser           the operator's invitation
//   CustomMessage_UpdateUserAttribute,      refused: there is no change of email (the lead stays bound
//   _VerifyUserAttribute, anything else     to the verified address)
//
// No attribute the user wrote is ever read into the email (not `name`, not anything): only Cognito's
// placeholders and fixed texts. The trigger reads only `Runtime/KILL#*`; no table, no secret.
import type { CustomMessageTriggerEvent } from "aws-lambda";
import { z } from "zod";
import { describeError } from "../auth/errors";
import { type AuthEmailKind, authEmailLocale, renderAuthEmail } from "../copy/auth-emails";
import { withDeadline } from "../lib/deadline";
import { type Logger, createLogger } from "../lib/log";
import { killSwitchReader } from "../ops/defaults";
import { type KillSwitchReader, blockingScope } from "../ops/kill-switch";
import { CONSOLE_ORIGIN } from "../policy/rules-content";

/** Below the 5 s Cognito gives a trigger. */
export const CUSTOM_MESSAGE_DEADLINE_MS = 4_000;

const KIND_OF_SOURCE: Readonly<Record<string, AuthEmailKind>> = {
  CustomMessage_SignUp: "SIGN_UP",
  CustomMessage_ResendCode: "RESEND_CODE",
  CustomMessage_ForgotPassword: "FORGOT_PASSWORD",
  CustomMessage_AdminCreateUser: "ADMIN_CREATE_USER",
};

/** The codes the cut refuses: the sign-up's and its resend. */
const CUT_KINDS: ReadonlySet<AuthEmailKind> = new Set(["SIGN_UP", "RESEND_CODE"]);

export type CustomMessageRefusal = "CAP_REACHED" | "SOURCE_NOT_ALLOWED";

export class CustomMessageRefused extends Error {
  override readonly name = "CustomMessageRefused";
  constructor(readonly code: CustomMessageRefusal) {
    super(code);
  }
}

// zod at the edge: only what the trigger reads. `locale` is the one attribute it looks at, to pick a language.
const CustomMessageEvent = z.looseObject({
  triggerSource: z.string().min(1).max(64),
  request: z.looseObject({
    userAttributes: z.looseObject({ locale: z.string().max(16).optional() }),
    codeParameter: z.string().min(1).max(64),
    usernameParameter: z.string().max(64).nullish(),
  }),
});

export interface CustomMessageDeps {
  readonly kill: Pick<KillSwitchReader, "status">;
  /** Console origin for the invitation's link and the logo. */
  readonly origin: string;
  readonly log: Logger;
}

export interface CustomMessage {
  readonly emailSubject: string;
  readonly emailMessage: string;
}

export async function composeCustomMessage(deps: CustomMessageDeps, event: z.infer<typeof CustomMessageEvent>): Promise<CustomMessage> {
  const kind = KIND_OF_SOURCE[event.triggerSource];
  if (kind === undefined) throw new CustomMessageRefused("SOURCE_NOT_ALLOWED");
  if (CUT_KINDS.has(kind) && blockingScope(await deps.kill.status(), "SIGNUP") !== undefined) throw new CustomMessageRefused("CAP_REACHED");
  const email = renderAuthEmail(
    kind,
    authEmailLocale(event.request.userAttributes.locale),
    { code: event.request.codeParameter, ...(kind === "ADMIN_CREATE_USER" ? { username: event.request.usernameParameter ?? "{username}" } : {}) },
    { loginUrl: `${deps.origin}/login`, logoUrl: `${deps.origin}/brand/logo-craftech-color.png` },
  );
  return { emailSubject: email.subject, emailMessage: email.html };
}

export function createCustomMessageHandler(depsOf: (log: Logger) => CustomMessageDeps, newLogger: () => Logger) {
  return async (event: CustomMessageTriggerEvent): Promise<CustomMessageTriggerEvent> => {
    const log = newLogger();
    const source = typeof event?.triggerSource === "string" ? event.triggerSource.slice(0, 64) : "unknown";
    const parsed = CustomMessageEvent.safeParse(event);
    let message: CustomMessage;
    try {
      if (!parsed.success) throw new CustomMessageRefused("SOURCE_NOT_ALLOWED");
      message = await withDeadline("auth.custommessage", CUSTOM_MESSAGE_DEADLINE_MS, () => composeCustomMessage(depsOf(log), parsed.data));
    } catch (error) {
      if (error instanceof CustomMessageRefused) {
        log.warn("auth.custommessage.refused", { triggerSource: source, reason: error.code, ...(error.code === "CAP_REACHED" ? { metric: "SignupCodeWithheld", value: 1 } : {}) });
        throw error;
      }
      // Without the cut's answer no sign-up code goes out (fail closed); the recovery never asks it.
      log.error("auth.custommessage.failed", { triggerSource: source, ...describeError(error) });
      throw error;
    }
    event.response.emailSubject = message.emailSubject;
    event.response.emailMessage = message.emailMessage;
    log.info("auth.custommessage.composed", { triggerSource: source });
    return event;
  };
}

export const handler = createCustomMessageHandler(
  (log) => ({ kill: killSwitchReader(), origin: CONSOLE_ORIGIN, log }),
  () => createLogger({ bindings: { service: "auth-custom-message" } }),
);
