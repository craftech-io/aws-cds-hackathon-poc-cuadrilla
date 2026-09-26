// Reads the principal out of the Cognito id token. The console only decodes the payload: the
// signature is verified by the BFF on every call, and the JWT is the only source of `ispId`, role
// and `isGuest`, stamped by the pre-token trigger from the registry (never the `custom:ispId`
// attribute) (docs/design-brief.md §6). Nothing here trusts user input.
import { ConsoleRole } from "@cuadrilla/shared";
import { z } from "zod";

const IdTokenClaimsSchema = z.looseObject({
  sub: z.string().min(1),
  iss: z.string().min(1),
  aud: z.string().min(1),
  exp: z.number().int(),
  iat: z.number().int(),
  token_use: z.literal("id"),
  email: z.string().optional(),
  name: z.string().optional(),
  ispId: z.string().min(1).optional(),
  role: z.string().optional(),
  /** Stamped as the string "true" for guest accounts (packages/bff/src/auth/principal.ts). */
  isGuest: z.string().optional(),
  "cognito:groups": z.array(z.string()).optional(),
});

export type IdTokenClaims = z.infer<typeof IdTokenClaimsSchema>;

export interface Principal {
  readonly sub: string;
  readonly email?: string;
  readonly name?: string;
  /** Operator the user belongs to; absent until the registry assigns one. */
  readonly ispId?: string;
  readonly role?: ConsoleRole;
  readonly groups: readonly ConsoleRole[];
  /** A guest acts as supervisor in its own world, never with TOTP or a password change. */
  readonly isGuest: boolean;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

// Precedence of the Cognito groups: the enum is declared in precedence order, SUPERVISOR first.
const ROLE_PRECEDENCE: readonly ConsoleRole[] = ConsoleRole.options;

function decodeBase64Url(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function decodeJwtPayload(token: string): unknown {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("malformed JWT");
  return JSON.parse(decodeBase64Url(payload)) as unknown;
}

export function parseIdTokenClaims(token: string): IdTokenClaims {
  return IdTokenClaimsSchema.parse(decodeJwtPayload(token));
}

function groupsOf(claims: IdTokenClaims): ConsoleRole[] {
  return (claims["cognito:groups"] ?? [])
    .map((group) => ConsoleRole.safeParse(group))
    .flatMap((result) => (result.success ? [result.data] : []))
    .sort((a, b) => ROLE_PRECEDENCE.indexOf(a) - ROLE_PRECEDENCE.indexOf(b));
}

function roleOf(claims: IdTokenClaims, groups: readonly ConsoleRole[]): ConsoleRole | undefined {
  const explicit = ConsoleRole.safeParse(claims.role);
  if (explicit.success) return explicit.data;
  return groups[0];
}

export function principalFromClaims(claims: IdTokenClaims): Principal {
  const groups = groupsOf(claims);
  const role = roleOf(claims, groups);
  const principal: Principal = {
    sub: claims.sub,
    groups,
    isGuest: role === "GUEST" || claims.isGuest === "true",
    expiresAt: claims.exp * 1000,
    ...(claims.email !== undefined ? { email: claims.email } : {}),
    ...(claims.name !== undefined ? { name: claims.name } : {}),
    ...(claims.ispId !== undefined ? { ispId: claims.ispId } : {}),
  };
  return role ? { ...principal, role } : principal;
}

export function principalFromIdToken(token: string): Principal {
  return principalFromClaims(parseIdTokenClaims(token));
}
