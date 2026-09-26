// The Cognito calls of the own sign-up (ADR-0025 §1 and §3), with the public `GuestSignup` client and
// no credentials: `SignUp` with the user and the ticket `signup.start` issued (the password goes from
// the browser to Cognito only, never to the BFF), `ConfirmSignUp` with the emailed code and
// `ResendConfirmationCode`. Signing in afterwards is the console's own SRP flow (`ConsoleWeb`).
import { z } from "zod";
import type { LegalLocale } from "@cuadrilla/shared/legal/consents";
import { type CognitoApiConfig, createCognitoCaller } from "./cognito";

export interface SignUpRequest {
  /** `gst-<ULID>` from `signup.start`: the only user this ticket may create. */
  readonly username: string;
  readonly password: string;
  readonly email: string;
  /** Language of the authentication emails (the custom message trigger reads it). */
  readonly locale: LegalLocale;
  readonly name?: string;
  readonly ticket: string;
}

export interface SignupCognitoApi {
  signUp(request: SignUpRequest): Promise<void>;
  confirmSignUp(username: string, code: string): Promise<void>;
  resendCode(username: string): Promise<void>;
}

const Answer = z.looseObject({});

export function createSignupCognitoApi(config: CognitoApiConfig): SignupCognitoApi {
  const call = createCognitoCaller(config);
  const ClientId = config.clientId;
  return {
    async signUp(request) {
      const attributes = [
        { Name: "email", Value: request.email },
        { Name: "locale", Value: request.locale },
        ...(request.name === undefined ? [] : [{ Name: "name", Value: request.name }]),
      ];
      await call("SignUp", { ClientId, Username: request.username, Password: request.password, UserAttributes: attributes, ClientMetadata: { signupTicket: request.ticket } }, Answer, false);
    },
    async confirmSignUp(username, code) {
      await call("ConfirmSignUp", { ClientId, Username: username, ConfirmationCode: code }, Answer, false);
    },
    async resendCode(username) {
      await call("ResendConfirmationCode", { ClientId, Username: username }, Answer, false);
    },
  };
}
