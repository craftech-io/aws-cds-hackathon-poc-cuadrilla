// `npm run qa:confirm-signup -- --username gst-<ULID>` (ADR-0025 §7, docs/test-plan.md §6.1): the QA
// seam of the deployed verification. Nobody reads the code Cognito mails to the SES mailbox simulator,
// so the operator confirms the sign-up of a QA address administratively, with the operator's profile
// through `sst shell`, never in CI.
//
// The fence is the address Cognito holds, never one given here: the script takes only the `gst-*`
// user, reads its `email` with `AdminGetUser` and goes on only when THAT value matches
// `^success\+qa-[a-z0-9-]{1,60}@simulator\.amazonses\.com$` (leads/keys.ts, QA_ADDRESS_PATTERN). Then
// `AdminConfirmSignUp`, which runs the real post confirmation (lead CONFIRMED, registry row, world).
// `AdminConfirmSignUp` does not verify the email (a code typed on the web would), and the web signs in
// with the email alias, which Cognito accepts only once verified: with `--verify-email` (the default)
// the seam also sets `email_verified = true` on that same fenced user (FL-105, "la verificación
// desplegada lo exige en true").
//
// Every run prints one JSON audit line `QA_SIGNUP_CONFIRMED` (or `QA_SIGNUP_REFUSED`) with the user and
// the address masked; the call itself stays in CloudTrail under the operator's principal.
//
//   npm run qa:confirm-signup -- --username gst-01K…            confirm (and verify the email)
//   npm run qa:confirm-signup -- --username gst-01K… --status   read only: status and email_verified
/// <reference path="../../sst-env.d.ts" />
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { AdminConfirmSignUpCommand, AdminGetUserCommand, AdminUpdateUserAttributesCommand, UserNotFoundException } from "@aws-sdk/client-cognito-identity-provider";
import { QA_ADDRESS_PATTERN } from "../../packages/bff/src/leads/keys";
import { SIGNUP_USERNAME_PATTERN, canonicalSignupUsername } from "../../packages/bff/src/leads/model";
import { parseFlags } from "../channels/cli-args";
import { assertOperatorMachine } from "../leads/operator-only";

export const USAGE = "npm run qa:confirm-signup -- --username gst-<ULID> [--status] [--no-verify-email]";

export interface SeamRequest {
  readonly username: string;
  readonly statusOnly: boolean;
  readonly verifyEmail: boolean;
}

export function parseSeamArgs(argv: readonly string[]): SeamRequest {
  if (argv.some((arg) => arg.includes("@"))) throw new RangeError(`the seam takes the gst-* user, never an address\n${USAGE}`);
  let username: string | undefined;
  let statusOnly = false;
  let verifyEmail = true;
  parseFlags(argv, {
    "--username": (value) => {
      username = canonicalSignupUsername(value());
    },
    "--status": () => {
      statusOnly = true;
    },
    "--no-verify-email": () => {
      verifyEmail = false;
    },
  });
  if (username === undefined || !SIGNUP_USERNAME_PATTERN.test(username)) throw new RangeError(`--username must be a gst-<ULID> user of the own sign-up\n${USAGE}`);
  return { username, statusOnly, verifyEmail };
}

/** `success+qa-run-1@simulator.amazonses.com` → `s***@simulator.amazonses.com`. */
export function maskAddress(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 1 ? "***" : `${email.charAt(0)}***${email.slice(at)}`;
}

export type SeamOutcome =
  | { readonly outcome: "CONFIRMED"; readonly userStatus: string; readonly emailVerified: boolean; readonly verifiedBySeam: boolean }
  | { readonly outcome: "STATUS"; readonly userStatus: string; readonly emailVerified: boolean }
  | { readonly outcome: "NOT_FOUND" }
  | { readonly outcome: "REFUSED"; readonly reason: "NOT_A_QA_ADDRESS" };

interface UserView {
  readonly status: string;
  readonly email: string | undefined;
  readonly emailVerified: boolean;
}

async function readUser(cognito: Pick<CognitoIdentityProviderClient, "send">, userPoolId: string, username: string): Promise<UserView | undefined> {
  try {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
    const attribute = (name: string) => user.UserAttributes?.find((entry) => entry.Name === name)?.Value;
    return { status: user.UserStatus ?? "UNKNOWN", email: attribute("email"), emailVerified: attribute("email_verified") === "true" };
  } catch (error) {
    if (error instanceof UserNotFoundException || (error as { name?: string }).name === "UserNotFoundException") return undefined;
    throw error;
  }
}

export interface SeamDeps {
  readonly cognito: Pick<CognitoIdentityProviderClient, "send">;
  readonly userPoolId: string;
  readonly audit: (line: Record<string, unknown>) => void;
  readonly now: () => Date;
}

/** The seam: the fence on the address Cognito holds, then the confirmation (and the verified email). */
export async function runSeam(request: SeamRequest, deps: SeamDeps): Promise<SeamOutcome> {
  const user = await readUser(deps.cognito, deps.userPoolId, request.username);
  const base = { at: deps.now().toISOString(), user: request.username.slice(0, 8), actor: "OPERATOR" };
  if (user === undefined) return { outcome: "NOT_FOUND" };
  if (request.statusOnly) return { outcome: "STATUS", userStatus: user.status, emailVerified: user.emailVerified };
  if (user.email === undefined || !QA_ADDRESS_PATTERN.test(user.email.trim().toLowerCase())) {
    deps.audit({ kind: "QA_SIGNUP_REFUSED", reason: "NOT_A_QA_ADDRESS", ...base });
    return { outcome: "REFUSED", reason: "NOT_A_QA_ADDRESS" };
  }
  if (user.status === "UNCONFIRMED") await deps.cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: deps.userPoolId, Username: request.username }));
  let verifiedBySeam = false;
  if (request.verifyEmail && !user.emailVerified) {
    await deps.cognito.send(new AdminUpdateUserAttributesCommand({ UserPoolId: deps.userPoolId, Username: request.username, UserAttributes: [{ Name: "email_verified", Value: "true" }] }));
    verifiedBySeam = true;
  }
  const after = await readUser(deps.cognito, deps.userPoolId, request.username);
  const outcome: SeamOutcome = { outcome: "CONFIRMED", userStatus: after?.status ?? "UNKNOWN", emailVerified: after?.emailVerified ?? false, verifiedBySeam };
  deps.audit({ kind: "QA_SIGNUP_CONFIRMED", email: maskAddress(user.email), previousStatus: user.status, emailVerifiedBefore: user.emailVerified, ...outcome, ...base });
  return outcome;
}

async function main(): Promise<SeamOutcome> {
  assertOperatorMachine();
  const request = parseSeamArgs(process.argv.slice(2));
  const [{ CognitoIdentityProviderClient: Client }, { awsClientConfig }, { authConfig }] = await Promise.all([
    import("@aws-sdk/client-cognito-identity-provider"),
    import("../../packages/bff/src/lib/clients"),
    import("../../packages/bff/src/auth/config"),
  ]);
  const cognito = new Client({ region: "us-east-1", ...awsClientConfig({ requestTimeoutMs: 10_000, connectionTimeoutMs: 2_000, maxAttempts: 3 }) });
  return runSeam(request, { cognito, userPoolId: authConfig().userPoolId, audit: (line) => console.log(JSON.stringify(line)), now: () => new Date() });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
    .then((outcome) => {
      console.log(`qa:confirm-signup: ${JSON.stringify(outcome)}`);
      if (outcome.outcome === "REFUSED" || outcome.outcome === "NOT_FOUND") process.exit(2);
    })
    .catch((error: unknown) => {
      console.error(`qa:confirm-signup: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
