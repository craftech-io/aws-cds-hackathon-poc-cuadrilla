// The fence of the QA seam of the own sign-up (ADR-0025 §7, docs/test-plan.md §4.1): nobody reads the
// code Cognito mails to the SES simulator, so `SC-20` confirms and signs in administratively, and only for
// a `gst-*` user whose email IN COGNITO (read with `AdminGetUser`, never taken from the input) matches
// `^success\+qa-[a-z0-9-]{1,60}@simulator\.amazonses\.com$`. An address in the input proves nothing: a
// call that names a QA address for a user whose Cognito email is a real one is refused (guard.test.ts).
import { ToolError } from "@cuadrilla/shared";
import { QA_ADDRESS_PATTERN } from "../leads/keys";
import { QA_REASON } from "./contract";

/** A user of the pool as `AdminGetUser` answers it. */
export interface SeamUser {
  readonly username: string;
  readonly status: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly sub?: string;
}

/** Cognito as the seam reaches it (the QaDriver's grants: AdminGetUser, AdminConfirmSignUp, AdminInitiateAuth). */
export interface SeamCognito {
  getUser(username: string): Promise<SeamUser | undefined>;
  confirm(username: string): Promise<void>;
  /** `ADMIN_USER_PASSWORD_AUTH` with the `QaProbe` client: the id token (5 minutes). */
  adminSignIn(username: string, password: string): Promise<{ readonly idToken: string }>;
  /** `SignUp` with the `GuestSignup` client (no credentials: a public API), the ticket in `clientMetadata`. */
  signUp(input: { readonly username: string; readonly password: string; readonly email: string; readonly locale: string; readonly name: string; readonly ticket?: string }): Promise<void>;
}

/** `success+qa-run-1@simulator.amazonses.com` → `s***@simulator.amazonses.com` (what a report may carry). */
export function maskQaAddress(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 1 ? "***" : `${email.charAt(0)}***${email.slice(at)}`;
}

export function isQaAddress(email: string | undefined): boolean {
  return email !== undefined && QA_ADDRESS_PATTERN.test(email.trim().toLowerCase());
}

/** The user, only when the address Cognito holds is a QA address; FORBIDDEN otherwise (and NOT_FOUND). */
export async function requireQaUser(cognito: Pick<SeamCognito, "getUser">, username: string): Promise<SeamUser & { readonly email: string }> {
  const user = await cognito.getUser(username);
  if (user === undefined) throw new ToolError("NOT_FOUND", "no such user in the pool");
  if (user.email === undefined || !isQaAddress(user.email)) throw new ToolError("FORBIDDEN", "the seam acts only on users whose address in Cognito is a QA address", QA_REASON.NOT_A_QA_ADDRESS);
  return { ...user, email: user.email };
}
