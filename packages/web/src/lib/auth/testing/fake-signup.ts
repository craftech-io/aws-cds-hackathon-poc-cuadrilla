// Test-only side of the fake pool for the own sign-up (`GuestSignup`): `SignUp` creates an unconfirmed
// user and "emails" a code the test reads, `ConfirmSignUp` checks it and turns the user into a
// confirmed `GUEST` of the sign-up's own operator in the fake pool, so the console's real SRP sign-in
// works right after, and `ResendConfirmationCode` issues a new code. The pre sign-up trigger is a hook:
// a test makes it refuse with a code (`TICKET_INVALID`, `EMAIL_TAKEN`, `CAP_REACHED`) the way Cognito
// reports a trigger's refusal. Every request is recorded (operation and body) for the assertions.
import { CognitoError } from "../cognito";
import { missingPasswordRules } from "../credentials";
import type { SignUpRequest, SignupCognitoApi } from "../signup-cognito";
import type { FakeCognito } from "./fake-cognito";

/** Operator of a sign-up generation (ADR-0025 §2) stamped on the confirmed user's tokens. */
export const FAKE_SIGNUP_ISP = "isp-guest-s261020abcde";

interface PendingUser {
  readonly email: string;
  readonly password: string;
  readonly name: string | undefined;
  readonly locale: string;
  code: string;
  confirmed: boolean;
}

export interface SignupCall {
  readonly operation: "SignUp" | "ConfirmSignUp" | "ResendConfirmationCode";
  readonly username: string;
  readonly ticket?: string;
  readonly locale?: string;
}

export class FakeSignupPool implements SignupCognitoApi {
  readonly calls: SignupCall[] = [];
  /** The code the pre sign-up trigger refuses the next `SignUp` with. */
  refuseNextSignUp: string | undefined;
  /** Makes the next call of this operation fail with this Cognito error type ("network" for no answer). */
  failNext: { readonly operation: SignupCall["operation"]; readonly type: string } | undefined;
  private readonly users = new Map<string, PendingUser>();
  private counter = 0;

  constructor(private readonly pool: FakeCognito) {}

  private nextCode(): string {
    this.counter += 1;
    return String(100_000 + ((this.counter * 7_919) % 900_000));
  }

  private check(operation: SignupCall["operation"]): void {
    const failure = this.failNext;
    if (failure?.operation !== operation) return;
    this.failNext = undefined;
    if (failure.type === "network") throw new TypeError("Failed to fetch");
    throw new CognitoError(failure.type, "injected failure");
  }

  async signUp(request: SignUpRequest): Promise<void> {
    this.calls.push({ operation: "SignUp", username: request.username, ticket: request.ticket, locale: request.locale });
    this.check("SignUp");
    const refusal = this.refuseNextSignUp;
    if (refusal !== undefined) {
      this.refuseNextSignUp = undefined;
      throw new CognitoError("UserLambdaValidationException", `PreSignUp failed with error ${refusal}.`);
    }
    if (this.users.has(request.username)) throw new CognitoError("UsernameExistsException", "User already exists");
    if (missingPasswordRules(request.password).length > 0) throw new CognitoError("InvalidPasswordException", "Password did not conform with policy");
    this.users.set(request.username, { email: request.email.toLowerCase(), password: request.password, name: request.name, locale: request.locale, code: this.nextCode(), confirmed: false });
  }

  async confirmSignUp(username: string, code: string): Promise<void> {
    this.calls.push({ operation: "ConfirmSignUp", username });
    this.check("ConfirmSignUp");
    const user = this.users.get(username);
    if (user === undefined) throw new CognitoError("CodeMismatchException", "Invalid verification code provided, please try again.");
    if (user.confirmed) throw new CognitoError("NotAuthorizedException", "User cannot be confirmed. Current status is CONFIRMED");
    if (user.code !== code) throw new CognitoError("CodeMismatchException", "Invalid verification code provided, please try again.");
    try {
      this.pool.user(user.email);
      throw new CognitoError("AliasExistsException", "An account with the email already exists.");
    } catch (error) {
      if (error instanceof CognitoError) throw error;
    }
    user.confirmed = true;
    await this.pool.addUser({ email: user.email, password: user.password, role: "GUEST", ispId: FAKE_SIGNUP_ISP, status: "CONFIRMED", ...(user.name === undefined ? {} : { name: user.name }) });
  }

  async resendCode(username: string): Promise<void> {
    this.calls.push({ operation: "ResendConfirmationCode", username });
    this.check("ResendConfirmationCode");
    const user = this.users.get(username);
    if (user !== undefined && !user.confirmed) user.code = this.nextCode();
  }

  /** The code the last email to this address carried (what the visitor would read in the inbox). */
  codeFor(email: string): string {
    const user = [...this.users.values()].find((candidate) => candidate.email === email.toLowerCase() && !candidate.confirmed);
    if (user === undefined) throw new Error(`no pending sign-up for ${email}`);
    return user.code;
  }

  /** Test seam: the pending user of an email, for assertions (locale, name). */
  pendingOf(email: string): Readonly<Omit<PendingUser, "password">> | undefined {
    const user = [...this.users.values()].find((candidate) => candidate.email === email.toLowerCase());
    if (user === undefined) return undefined;
    const { password: _password, ...rest } = user;
    return rest;
  }
}
