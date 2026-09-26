import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { guestAccountDeletionName } from "../../infra/leads-spec";
import type { EmailSource } from "./email-input";
import { describeOutcome, main, runDelete } from "./delete";

const EMAIL = "ana.prueba@example.com";
const source = (stdin: string): EmailSource => ({ readStdin: async () => stdin, readFile: async () => stdin });

describe("leads:delete [FL-118]", () => {
  const lambda = mockClient(LambdaClient);
  const answer = (value: unknown) => ({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(value)) as never });
  beforeEach(() => lambda.reset());

  it("[FL-118] invokes GuestAccountDeletion by its fixed name with {email, actor: OPERATOR} and reports the leadId", async () => {
    lambda.on(InvokeCommand).resolves(answer({ outcome: "DELETED", leadId: "01K6ABCDEFGHJKMNPQRSTVWXYZ", deletedUsers: 2 }));
    const result = await runDelete(EMAIL, { lambda: new LambdaClient({}), functionName: guestAccountDeletionName() });
    expect(result).toEqual({ outcome: "DELETED", leadId: "01K6ABCDEFGHJKMNPQRSTVWXYZ", deletedUsers: 2 });
    const input = lambda.commandCalls(InvokeCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ FunctionName: "aws-cds-hackathon-poc-cuadrilla-poc-guest-account-deletion", InvocationType: "RequestResponse" });
    expect(JSON.parse(new TextDecoder().decode(input?.Payload as Uint8Array))).toEqual({ email: EMAIL, actor: "OPERATOR" });
    expect(describeOutcome(result)).toContain("01K6ABCDEFGHJKMNPQRSTVWXYZ");
    expect(describeOutcome(result)).not.toContain("@");
  });

  it("[FL-118] reports a refusal or nothing to delete as such, and a failed invocation as an error", async () => {
    expect(describeOutcome({ outcome: "REFUSED", reason: "NOT_A_SIGNUP_GUEST" })).toContain("refused");
    expect(describeOutcome({ outcome: "NOTHING_TO_DELETE" })).toContain("nothing to delete");
    lambda.on(InvokeCommand).resolves({ StatusCode: 200, FunctionError: "Unhandled", Payload: new TextEncoder().encode("{}") as never });
    await expect(runDelete(EMAIL, { lambda: new LambdaClient({}), functionName: guestAccountDeletionName() })).rejects.toThrow("nothing is reported as deleted");
  });

  it("[FL-118] reads the address from standard input or --email-file, never from an argument", async () => {
    await expect(main([EMAIL], source(EMAIL), {})).rejects.toThrow("never from an argument");
    await expect(main(["--email-file"], source(EMAIL), {})).rejects.toThrow("needs a value");
    expect(lambda.commandCalls(InvokeCommand)).toHaveLength(0);
  });
});
