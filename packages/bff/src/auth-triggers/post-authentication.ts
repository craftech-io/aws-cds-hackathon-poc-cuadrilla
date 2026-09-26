/// <reference path="../../sst-env.d.ts" />
// Cognito post authentication trigger (ADR-0025 §1-§2, infra/auth.ts `AuthPostAuthentication`), on each
// sign-in: by the registry row of the `sub` (guest/sign-in.ts), a sign-up guest refreshes its lead and
// gets a new generation when its world expired or is missing; an invited or rehearsal guest without a
// world gets one; a supervisor, an operator or an account without a row gets nothing at all.
//
// A sign-in is never refused for any of this: a failure is logged and the event returned, and the
// portada offers "Reintentar". The trigger works within 4 s of the 5 Cognito waits.
//
// Links: `Leads`, `Isps` and `Runtime` by name (fenced by its IAM row), `CostCaps` and `GuestWorlds`.
import type { PostAuthenticationTriggerEvent } from "aws-lambda";
import { z } from "zod";
import { tableClient } from "../connector/index";
import { lambdaProvisioner } from "../guest/provisioner";
import { type SignInDeps, type SignInOutcome, onSignIn } from "../guest/sign-in";
import { dynamoLeadStore } from "../leads/dynamo-table";
import { withDeadline } from "../lib/deadline";
import { type Logger, createLogger } from "../lib/log";
import { describeError } from "../auth/errors";

export const POST_AUTHENTICATION_DEADLINE_MS = 4_000;

const PostAuthenticationEvent = z.looseObject({
  triggerSource: z.string().min(1),
  request: z.looseObject({ userAttributes: z.record(z.string(), z.string()) }),
});

export interface PostAuthenticationDeps {
  readonly signIn: () => Omit<SignInDeps, "log">;
  readonly newLogger: () => Logger;
}

export function createPostAuthenticationHandler(deps: PostAuthenticationDeps) {
  return async (event: PostAuthenticationTriggerEvent): Promise<PostAuthenticationTriggerEvent> => {
    const log = deps.newLogger();
    const parsed = PostAuthenticationEvent.safeParse(event);
    if (!parsed.success) {
      log.error("auth.postauthentication.invalid_event", {});
      return event;
    }
    try {
      const outcome: SignInOutcome = await withDeadline("auth.postauthentication", POST_AUTHENTICATION_DEADLINE_MS, () =>
        onSignIn({ ...deps.signIn(), log }, { triggerSource: parsed.data.triggerSource, sub: parsed.data.request.userAttributes.sub ?? "" }),
      );
      log.info("auth.postauthentication.done", { kind: outcome.kind, ...(outcome.kind === "NONE" ? { why: outcome.why } : { userId: outcome.userId }) });
    } catch (error) {
      log.error("auth.postauthentication.failed", { metric: "GuestSignInFailed", value: 1, ...describeError(error) });
    }
    return event;
  };
}

let defaults: Omit<SignInDeps, "log"> | undefined;

function defaultSignIn(): Omit<SignInDeps, "log"> {
  defaults ??= { client: tableClient(), leads: dynamoLeadStore(), provisioner: lambdaProvisioner(), now: () => new Date() };
  return defaults;
}

export const handler = createPostAuthenticationHandler({
  signIn: defaultSignIn,
  newLogger: () => createLogger({ bindings: { service: "auth-post-authentication" } }),
});
