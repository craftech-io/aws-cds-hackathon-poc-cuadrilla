/// <reference path="../../sst-env.d.ts" />
// Cognito post confirmation trigger (ADR-0025 §1, infra/auth.ts `AuthPostConfirmation`): the confirmed
// email of the own sign-up becomes a `GUEST` with a world (guest/confirmation.ts). It acts only for a
// user `gst-<ULID>` whose pending lead lists it and whose `sub` has no registry; anything else is a no-op
// logged as `SIGNUP_CONFIRM_IGNORED`. The world is built by `GuestWorlds`, asynchronously: the trigger
// works within 4 s of the 5 Cognito waits and returns the event untouched.
//
// Links: `Leads`, `Isps` and `Runtime` by name (every access fenced by its IAM row), `SessionTokenKey`
// (the `email-hash` subkey of the lead's key) and `GuestWorlds`. The email of the event is hashed at
// once and never logged.
import type { PostConfirmationTriggerEvent } from "aws-lambda";
import { z } from "zod";
import { type ConfirmationDeps, type ConfirmationOutcome, confirmSignup } from "../guest/confirmation";
import { withDeadline } from "../lib/deadline";
import { type Logger, createLogger } from "../lib/log";
import { describeError } from "../auth/errors";
import { linkedGuestFlowDeps } from "./guest-flow-deps";

/** Below the 5 s Cognito gives a trigger. */
export const POST_CONFIRMATION_DEADLINE_MS = 4_000;

// zod at the edge: only what the trigger reads.
const PostConfirmationEvent = z.looseObject({
  triggerSource: z.string().min(1),
  userName: z.string().min(1).max(128),
  request: z.looseObject({ userAttributes: z.record(z.string(), z.string()) }),
});

export interface PostConfirmationDeps {
  readonly confirmation: () => Omit<ConfirmationDeps, "log">;
  readonly newLogger: () => Logger;
}

export function createPostConfirmationHandler(deps: PostConfirmationDeps) {
  return async (event: PostConfirmationTriggerEvent): Promise<PostConfirmationTriggerEvent> => {
    const log = deps.newLogger();
    const parsed = PostConfirmationEvent.safeParse(event);
    if (!parsed.success) {
      log.error("auth.postconfirmation.invalid_event", { triggerSource: typeof event.triggerSource === "string" ? event.triggerSource : "unknown" });
      throw new Error("post confirmation: unexpected event");
    }
    const attributes = parsed.data.request.userAttributes;
    let outcome: ConfirmationOutcome;
    try {
      outcome = await withDeadline("auth.postconfirmation", POST_CONFIRMATION_DEADLINE_MS, () =>
        confirmSignup({ ...deps.confirmation(), log }, { triggerSource: parsed.data.triggerSource, userName: parsed.data.userName, sub: attributes.sub ?? "", email: attributes.email }),
      );
    } catch (error) {
      // Cognito keeps the user confirmed; a retry of the trigger finds its own rows and finishes.
      log.error("auth.postconfirmation.failed", { triggerSource: parsed.data.triggerSource, metric: "SignupConfirmFailed", value: 1, ...describeError(error) });
      throw error;
    }
    log.info("auth.postconfirmation.done", { kind: outcome.kind, ...(outcome.kind === "IGNORED" ? { reason: outcome.reason } : { userId: outcome.userId, status: outcome.status }) });
    return event;
  };
}

export const handler = createPostConfirmationHandler({
  confirmation: linkedGuestFlowDeps,
  newLogger: () => createLogger({ bindings: { service: "auth-post-confirmation" } }),
});
