/// <reference path="../../sst-env.d.ts" />
// Cognito post authentication trigger (ADR-0025 §1-§2, infra/auth.ts `AuthPostAuthentication`), on each
// sign-in: by the registry row of the `sub` (guest/sign-in.ts), a sign-up guest refreshes its lead and
// gets a new generation when its world expired or is missing; an invited or rehearsal guest without a
// world gets one; a supervisor or an operator gets nothing at all. A `gst-*` user without a row, or with
// a lead still pending, is a confirmation whose post confirmation trigger failed after Cognito had
// confirmed the user: the sign-in finishes it (guest/confirmation.ts, `resumeFromSignIn`).
//
// A sign-in is never refused for any of this: a failure is logged and the event returned, and the
// portada offers "Reintentar". The trigger works within 4 s of the 5 Cognito waits.
//
// Links: `Leads`, `Isps` and `Runtime` by name (fenced by its IAM row), `SessionTokenKey` (the
// `email-hash` subkey of the lead's key), `CostCaps` and `GuestWorlds`. The email is hashed and never logged.
import type { PostAuthenticationTriggerEvent } from "aws-lambda";
import { z } from "zod";
import { type SignInDeps, type SignInOutcome, onSignIn } from "../guest/sign-in";
import { withDeadline } from "../lib/deadline";
import { type Logger, createLogger } from "../lib/log";
import { describeError } from "../auth/errors";
import { linkedGuestFlowDeps } from "./guest-flow-deps";

export const POST_AUTHENTICATION_DEADLINE_MS = 4_000;

const PostAuthenticationEvent = z.looseObject({
  triggerSource: z.string().min(1),
  userName: z.string().min(1).max(128).optional(),
  request: z.looseObject({ userAttributes: z.record(z.string(), z.string()) }),
});

export interface PostAuthenticationDeps {
  readonly signIn: () => Omit<SignInDeps, "log">;
  readonly newLogger: () => Logger;
}

function describeOutcome(outcome: SignInOutcome): Record<string, string> {
  if (outcome.kind === "NONE") return { why: outcome.why };
  if (outcome.kind !== "CONFIRMATION") return { userId: outcome.userId };
  const finished = outcome.outcome;
  return finished.kind === "IGNORED" ? { confirmation: finished.kind, reason: finished.reason } : { confirmation: finished.kind, userId: finished.userId, status: finished.status };
}

export function createPostAuthenticationHandler(deps: PostAuthenticationDeps) {
  return async (event: PostAuthenticationTriggerEvent): Promise<PostAuthenticationTriggerEvent> => {
    const log = deps.newLogger();
    const parsed = PostAuthenticationEvent.safeParse(event);
    if (!parsed.success) {
      log.error("auth.postauthentication.invalid_event", {});
      return event;
    }
    const attributes = parsed.data.request.userAttributes;
    try {
      const outcome: SignInOutcome = await withDeadline("auth.postauthentication", POST_AUTHENTICATION_DEADLINE_MS, () =>
        onSignIn(
          { ...deps.signIn(), log },
          { triggerSource: parsed.data.triggerSource, sub: attributes.sub ?? "", userName: parsed.data.userName, email: attributes.email_verified === "true" ? attributes.email : undefined },
        ),
      );
      log.info("auth.postauthentication.done", { kind: outcome.kind, ...describeOutcome(outcome) });
    } catch (error) {
      log.error("auth.postauthentication.failed", { metric: "GuestSignInFailed", value: 1, ...describeError(error) });
    }
    return event;
  };
}

export const handler = createPostAuthenticationHandler({
  signIn: linkedGuestFlowDeps,
  newLogger: () => createLogger({ bindings: { service: "auth-post-authentication" } }),
});
