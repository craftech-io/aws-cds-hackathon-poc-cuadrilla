// Why a console request was refused. `reason` travels to the console in the tRPC error `data`
// so the web can react (re-authenticate, ask for the password again) without parsing messages.
export const AUTH_REASON = {
  TOKEN_MISSING: "TOKEN_MISSING",
  TOKEN_INVALID: "TOKEN_INVALID",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  /** The token is genuine but carries no operator or no role: the invitation is incomplete. */
  PRINCIPAL_INCOMPLETE: "PRINCIPAL_INCOMPLETE",
  USER_INACTIVE: "USER_INACTIVE",
  ROLE_NOT_ALLOWED: "ROLE_NOT_ALLOWED",
  CROSS_ISP: "CROSS_ISP",
  /** The last interactive sign-in is older than 15 minutes: validating needs a fresh password. */
  LOGIN_NOT_RECENT: "LOGIN_NOT_RECENT",
  /** Cognito (JWKS or AdminGetUser) could not be reached; the request fails closed. */
  AUTH_UNAVAILABLE: "AUTH_UNAVAILABLE",
} as const;
export type AuthReason = (typeof AUTH_REASON)[keyof typeof AUTH_REASON];

/** What a refusal means over HTTP: 401, 403 or 503. */
export type AuthRefusal = "UNAUTHENTICATED" | "FORBIDDEN" | "UNAVAILABLE";

export const AUTH_REFUSAL: Readonly<Record<AuthReason, AuthRefusal>> = {
  TOKEN_MISSING: "UNAUTHENTICATED",
  TOKEN_INVALID: "UNAUTHENTICATED",
  TOKEN_EXPIRED: "UNAUTHENTICATED",
  PRINCIPAL_INCOMPLETE: "UNAUTHENTICATED",
  USER_INACTIVE: "FORBIDDEN",
  ROLE_NOT_ALLOWED: "FORBIDDEN",
  CROSS_ISP: "FORBIDDEN",
  LOGIN_NOT_RECENT: "FORBIDDEN",
  AUTH_UNAVAILABLE: "UNAVAILABLE",
};

/** Error class and message only, for log lines: stacks and causes may quote request data. */
export function describeError(error: unknown): { errorName: string; errorMessage?: string } {
  if (error instanceof Error) return { errorName: error.name, errorMessage: error.message };
  return { errorName: "UnknownError" };
}

export class AuthError extends Error {
  override readonly name = "AuthError";
  constructor(
    readonly reason: AuthReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  /** True when retrying later may succeed: nothing is wrong with the caller's credentials. */
  get unavailable(): boolean {
    return this.reason === AUTH_REASON.AUTH_UNAVAILABLE;
  }
}
