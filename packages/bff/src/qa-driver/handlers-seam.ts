// The QA seam of the own sign-up (ADR-0025 §7, docs/test-plan.md §4.1, `SC-20`): nobody reads the code
// Cognito mails to the SES simulator, so the driver
//
//   signup.start          runs the real `signup.start` of the `appRouter` with the run's counters
//                         (`…#qa-<runId>[-<scope>]#…`, `createQaPublicContext`), never over public HTTP
//   auth.signUp           `SignUp` with the `GuestSignup` client and the ticket (or without it, or with
//                         another user's, to see the pre sign-up refuse); the password is derived on the
//                         server and never leaves the driver
//   auth.confirmQaSignup  `AdminConfirmSignUp`, only for a user whose email IN COGNITO is a QA address
//   auth.qaLogin          `AdminInitiateAuth` with `QaProbe` (same fence): the principal the token carries
//   auth.cleanupQaSignup  `GuestAccountDeletion` with the user's `userId` (same fence; no `AdminDeleteUser`)
//   guest.forceExpire     the generation's `expiresAtReal` in the past (same fence)
//   guest.capsOverride    the limits of the QA scope of the slots (`GUESTWORLDS#QA#LIMITS`), never the public ones
//   leads.get             the lead with its email masked (same fence)
//
// Every fenced action logs `QA_SIGNUP_CONFIRMED` / `QA_SIGNUP_REFUSED` lines with the address masked.
import { ToolError } from "@cuadrilla/shared";
import { CONSENTS_VERSION } from "@cuadrilla/shared/legal/consents";
import { guestAccountKey } from "../leads/guest-accounts";
import { signupUserIdOf } from "../guest/registry";
import { setQaSlotLimits } from "../guest/slots";
import { QA_REASON, runIdOfKey } from "./contract";
import type { QaParsedInput } from "./contract-inputs";
import type { ActionContext } from "./driver";
import type { QaPorts } from "./ports";
import { maskQaAddress, requireQaUser } from "./signup-fence";

/** Why Cognito refused a `SignUp`: the pre sign-up's reason when it carries one (`TICKET_INVALID`…). */
export function signUpRefusalOf(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | undefined)?.name;
  const message = error instanceof Error ? error.message : "";
  if (name !== "UserLambdaValidationException" && name !== "InvalidParameterException" && name !== "NotAuthorizedException") return undefined;
  return /[A-Z][A-Z_]{3,}/.exec(message.replace(/^PreSignUp failed with error /, ""))?.[0] ?? String(name);
}

async function fenced(ports: QaPorts, username: string, ctx: ActionContext) {
  try {
    return await requireQaUser(ports.signup().cognito, username);
  } catch (error) {
    if (error instanceof ToolError && error.reason === QA_REASON.NOT_A_QA_ADDRESS) ctx.log.warn("qa_driver.seam", { kind: "QA_SIGNUP_REFUSED", user: username.slice(0, 8), action: ctx.scope.name });
    throw error;
  }
}

export function seamActions(ports: QaPorts) {
  return {
    async "signup.start"(input: QaParsedInput<"signup.start">, ctx: ActionContext) {
      const runId = `${runIdOfKey(ctx.idempotencyKey)}${input.scope === undefined ? "" : `-${input.scope}`}`;
      const form = {
        email: input.email,
        name: input.name,
        locale: input.locale,
        consents: { TERMS_PRIVACY: { accepted: input.termsAccepted, textVersion: CONSENTS_VERSION }, CONTACT: { accepted: input.contactAccepted, textVersion: CONSENTS_VERSION } },
        ...(input.utm === undefined ? {} : { attribution: { utm: input.utm } }),
      };
      const started = await ports.console.public(runId, ctx.log.correlationId).signup.start(form);
      return { username: started.username, ticket: started.ticket, expiresAt: started.expiresAt };
    },
    async "auth.signUp"(input: QaParsedInput<"auth.signUp">, ctx: ActionContext) {
      const seam = ports.signup();
      // A user that exists already is the seam's only when the address Cognito holds is a QA one.
      if ((await seam.cognito.getUser(input.username)) !== undefined) {
        const existing = await fenced(ports, input.username, ctx);
        return { outcome: "EXISTS", username: input.username, status: existing.status };
      }
      try {
        await seam.cognito.signUp({ username: input.username, password: seam.passwordOf(input.username), email: input.email, locale: "es-MX", name: "Invitada QA", ...(input.omitTicket || input.ticket === undefined ? {} : { ticket: input.ticket }) });
      } catch (error) {
        const reason = signUpRefusalOf(error);
        if (reason === undefined) throw error;
        ctx.log.info("qa_driver.seam", { kind: "SIGNUP_REFUSED", reason });
        return { outcome: "REFUSED", reason, userExists: (await seam.cognito.getUser(input.username)) !== undefined };
      }
      const user = await fenced(ports, input.username, ctx);
      return { outcome: "SIGNED_UP", username: input.username, status: user.status };
    },
    async "auth.confirmQaSignup"(input: QaParsedInput<"auth.confirmQaSignup">, ctx: ActionContext) {
      const seam = ports.signup();
      const user = await fenced(ports, input.username, ctx);
      if (user.status === "UNCONFIRMED") await seam.cognito.confirm(input.username);
      const after = await seam.cognito.getUser(input.username);
      ctx.log.info("qa_driver.seam", { kind: "QA_SIGNUP_CONFIRMED", user: input.username.slice(0, 8), email: maskQaAddress(user.email), previousStatus: user.status });
      return { username: input.username, previousStatus: user.status, status: after?.status ?? "UNKNOWN", ...(after?.sub === undefined ? {} : { sub: after.sub }) };
    },
    async "auth.qaLogin"(input: QaParsedInput<"auth.qaLogin">, ctx: ActionContext) {
      const seam = ports.signup();
      await fenced(ports, input.username, ctx);
      const { idToken } = await seam.cognito.adminSignIn(input.username, seam.passwordOf(input.username));
      const principal = await ports.console.token(idToken, ctx.log.correlationId);
      return { clockId: principal.clockId, ispId: principal.ispId, userId: principal.userId, role: principal.role, isGuest: principal.isGuest };
    },
    async "auth.cleanupQaSignup"(input: QaParsedInput<"auth.cleanupQaSignup">, ctx: ActionContext) {
      const seam = ports.signup();
      try {
        await fenced(ports, input.username, ctx);
      } catch (error) {
        if (error instanceof ToolError && error.code === "NOT_FOUND") return { outcome: "NOTHING_TO_DELETE" };
        throw error;
      }
      return seam.deleteAccount(signupUserIdOf(input.username));
    },
    async "guest.forceExpire"(input: QaParsedInput<"guest.forceExpire">, ctx: ActionContext) {
      await fenced(ports, input.username, ctx);
      const userId = signupUserIdOf(input.username);
      const now = ctx.now();
      const past = new Date(now.getTime() - 60_000).toISOString();
      const account = await ports.client.update("Runtime", guestAccountKey(userId), { expiresAtReal: past }, now.toISOString(), { equals: { guestOrigin: "SIGNUP" } });
      return { userId, clockId: account.clockId ?? null, expiresAtReal: past };
    },
    async "guest.capsOverride"(input: QaParsedInput<"guest.capsOverride">, ctx: ActionContext) {
      const limits = { activeWorlds: input.activeWorlds ?? 150, confirmedPerDay: input.signupsPerDay ?? 150 };
      await setQaSlotLimits(ports.client, limits, ctx.now());
      return limits;
    },
    async "leads.get"(input: QaParsedInput<"leads.get">, ctx: ActionContext) {
      const seam = ports.signup();
      const email = "email" in input ? input.email : (await fenced(ports, input.username, ctx)).email;
      const emailHash = seam.emailHash(email);
      const lead = await seam.leads.get(emailHash);
      if (lead === undefined) return { found: false };
      // A QA address reads only a QA lead (the origin is the server's decision, leads/keys.ts).
      if (lead.origin !== "QA") throw new ToolError("FORBIDDEN", "the seam reads only leads of QA addresses", QA_REASON.NOT_A_QA_ADDRESS);
      const events = await seam.leads.listEvents(emailHash);
      return {
        found: true,
        email: maskQaAddress(lead.email),
        status: lead.status ?? "PENDING",
        origin: lead.origin,
        locale: lead.locale,
        leadId: lead.leadId,
        consents: lead.consents,
        utm: lead.utm ?? null,
        pendingUsernames: lead.pendingUsernames,
        cognitoUsername: lead.cognitoUsername ?? null,
        hasSub: lead.cognitoSub !== undefined,
        userId: lead.userId ?? null,
        notifyOutcome: lead.notifyOutcome ?? null,
        lastLoginAt: lead.lastLoginAt ?? null,
        events: events.map((event) => ({ kind: event.kind, at: event.createdAt })),
      };
    },
  };
}
