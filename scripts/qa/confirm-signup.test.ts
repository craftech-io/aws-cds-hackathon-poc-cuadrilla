// The QA seam of the deployed verification (ADR-0025 §7): the fence is the address Cognito holds, never
// an input; a real address is refused without any write; the audit line never carries the address.
import { describe, expect, it } from "vitest";
import { maskAddress, parseSeamArgs, runSeam, type SeamDeps } from "./confirm-signup";

const USER = "gst-01K80000000000000000000001";

interface FakeUser {
  status: string;
  email: string;
  emailVerified: boolean;
}

function fakeCognito(user: FakeUser | undefined) {
  const writes: string[] = [];
  const send = async (command: { constructor: { name: string }; input: { Username?: string; UserAttributes?: Array<{ Name: string; Value: string }> } }) => {
    const name = command.constructor.name;
    if (name === "AdminGetUserCommand") {
      if (user === undefined) throw Object.assign(new Error("no user"), { name: "UserNotFoundException" });
      return { UserStatus: user.status, UserAttributes: [{ Name: "email", Value: user.email }, { Name: "email_verified", Value: String(user.emailVerified) }] };
    }
    writes.push(name);
    if (user !== undefined && name === "AdminConfirmSignUpCommand") user.status = "CONFIRMED";
    if (user !== undefined && name === "AdminUpdateUserAttributesCommand") user.emailVerified = command.input.UserAttributes?.some((entry) => entry.Name === "email_verified" && entry.Value === "true") ?? false;
    return {};
  };
  return { writes, cognito: { send } as unknown as SeamDeps["cognito"] };
}

function deps(cognito: SeamDeps["cognito"]) {
  const audit: Array<Record<string, unknown>> = [];
  return { audit, deps: { cognito, userPoolId: "us-east-1_Test", audit: (line: Record<string, unknown>) => audit.push(line), now: () => new Date("2026-09-27T02:00:00Z") } satisfies SeamDeps };
}

describe("qa:confirm-signup", () => {
  it("takes only a gst-* user, never an address", () => {
    expect(parseSeamArgs(["--username", USER])).toEqual({ username: USER, statusOnly: false, verifyEmail: true });
    expect(() => parseSeamArgs(["--username", "success+qa-x-1@simulator.amazonses.com"])).toThrow(/never an address/);
    expect(() => parseSeamArgs(["--username", "guest-07"])).toThrow(/gst-<ULID>/);
    expect(() => parseSeamArgs([])).toThrow(/gst-<ULID>/);
  });

  it("confirms and verifies the email of a QA address read from Cognito", async () => {
    const { cognito, writes } = fakeCognito({ status: "UNCONFIRMED", email: "success+qa-wp62-1@simulator.amazonses.com", emailVerified: false });
    const { audit, deps: seam } = deps(cognito);
    const outcome = await runSeam({ username: USER, statusOnly: false, verifyEmail: true }, seam);
    expect(outcome).toEqual({ outcome: "CONFIRMED", userStatus: "CONFIRMED", emailVerified: true, verifiedBySeam: true });
    expect(writes).toEqual(["AdminConfirmSignUpCommand", "AdminUpdateUserAttributesCommand"]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: "QA_SIGNUP_CONFIRMED", user: "gst-01K8", email: "s***@simulator.amazonses.com" });
    expect(JSON.stringify(audit)).not.toContain("success+qa");
  });

  it("refuses a user whose address in Cognito is not a QA one, without any write", async () => {
    for (const email of ["ana@example.com", "success@simulator.amazonses.com", "success+qa-x@simulator.amazonses.com.evil.test", "bounce+qa-x@simulator.amazonses.com"]) {
      const { cognito, writes } = fakeCognito({ status: "UNCONFIRMED", email, emailVerified: false });
      const { audit, deps: seam } = deps(cognito);
      expect(await runSeam({ username: USER, statusOnly: false, verifyEmail: true }, seam)).toEqual({ outcome: "REFUSED", reason: "NOT_A_QA_ADDRESS" });
      expect(writes).toEqual([]);
      expect(audit[0]).toMatchObject({ kind: "QA_SIGNUP_REFUSED" });
      expect(JSON.stringify(audit)).not.toContain(email);
    }
  });

  it("reads the status without writing, and reports a missing user", async () => {
    const { cognito, writes } = fakeCognito({ status: "CONFIRMED", email: "success+qa-wp62-1@simulator.amazonses.com", emailVerified: true });
    expect(await runSeam({ username: USER, statusOnly: true, verifyEmail: true }, deps(cognito).deps)).toEqual({ outcome: "STATUS", userStatus: "CONFIRMED", emailVerified: true });
    expect(writes).toEqual([]);
    expect(await runSeam({ username: USER, statusOnly: false, verifyEmail: true }, deps(fakeCognito(undefined).cognito).deps)).toEqual({ outcome: "NOT_FOUND" });
  });

  it("masks an address to its first letter and domain", () => {
    expect(maskAddress("success+qa-a-1@simulator.amazonses.com")).toBe("s***@simulator.amazonses.com");
    expect(maskAddress("nope")).toBe("***");
  });
});
