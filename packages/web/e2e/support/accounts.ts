// Console accounts of a spec, one per role (docs/architecture.md §10): a supervisor and operations
// staff of the demo operator, and a guest of its own world. They live in a fake user pool
// (src/lib/auth/testing/fake-cognito.ts: real SRP, real TOTP codes) whose id tokens carry the claims
// the pre-token trigger stamps and are signed with the run's ephemeral key. Passwords and TOTP
// secrets are generated per test and exist only in memory: no credential is written anywhere.
import { randomBytes } from "node:crypto";
import { FakeCognito } from "../../src/lib/auth/testing/fake-cognito";
import { randomBase32Secret } from "../../src/lib/auth/testing/totp";
import { signIdToken } from "./tokens";

/** Build-time variables of the Vite server the specs run against (src/lib/env.ts). */
export const E2E_POOL_ID = "us-east-1_E2eFakePool";
export const E2E_CLIENT_ID = "e2e-console-client";
/** The sign-up's `GuestSignup` client and the AWS WAF integration URL (its `challenge.js` is a route of the spec). */
export const E2E_SIGNUP_CLIENT_ID = "e2e-guest-signup-client";
export const E2E_WAF_INTEGRATION_URL = "https://e2e0waf.us-east-1.sdk.awswaf.com/e2e0waf/e2e0token/";

// The config imports this module in the main process: the web server it starts inherits these (like
// the run's key of tokens.ts), so the sign-up is configured without touching the config's own list.
process.env.VITE_COGNITO_SIGNUP_CLIENT_ID ??= E2E_SIGNUP_CLIENT_ID;
process.env.VITE_WAF_INTEGRATION_URL ??= E2E_WAF_INTEGRATION_URL;

export type AccountRole = "SUPERVISOR" | "OPS" | "GUEST";

export interface Account {
  readonly email: string;
  readonly password: string;
  readonly role: AccountRole;
  /** Set when the account already uses TOTP. */
  readonly totpSecret?: string;
}

export interface AccountInit {
  readonly role: AccountRole;
  /** An invited account signs in with a temporary password first (FORCE_CHANGE_PASSWORD). */
  readonly invited?: boolean;
  readonly withTotp?: boolean;
  readonly name?: string;
}

/** Operators of the accounts: the demo operator, and a guest's own one (`isp-guest-<nn>`). */
const ISP_OF_ROLE: Readonly<Record<AccountRole, string>> = { SUPERVISOR: "isp-demo", OPS: "isp-demo", GUEST: "isp-guest-07" };

/** A password the pool's policy accepts (12+ characters, lower, upper, digit, symbol), new every call. */
export function randomPassword(): string {
  return `Aa1-${randomBytes(18).toString("base64url")}`;
}

export function createPool(): FakeCognito {
  return new FakeCognito(E2E_POOL_ID, { signIdToken });
}

export async function addAccount(pool: FakeCognito, init: AccountInit): Promise<Account> {
  const password = randomPassword();
  const totpSecret = init.withTotp ? randomBase32Secret() : undefined;
  const email = `${init.role.toLowerCase()}-${randomBytes(4).toString("hex")}@example.test`;
  await pool.addUser({
    email,
    password,
    role: init.role,
    ispId: ISP_OF_ROLE[init.role],
    status: init.invited ? "FORCE_CHANGE_PASSWORD" : "CONFIRMED",
    ...(totpSecret !== undefined ? { totpSecret } : {}),
    ...(init.name !== undefined ? { name: init.name } : {}),
  });
  return { email, password, role: init.role, ...(totpSecret !== undefined ? { totpSecret } : {}) };
}
