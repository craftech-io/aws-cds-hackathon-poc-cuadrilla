// `npm run leads:delete` (ADR-0026, "Borrado a pedido"): a person asked to delete their data. The
// script invokes `GuestAccountDeletion` by its fixed name with `{email, actor: OPERATOR}`; the function
// resolves the lead, checks its target (a guest of the own sign-up, never an internal user nor an
// invited guest) and deletes with the stored `gst-*` users, never with the email. The operator's
// profile through `sst shell`, never CI; the address comes from standard input or `--email-file`.
// The script prints the outcome and the `leadId`: with it, the operator deletes the notice of that
// lead from the mailboxes that received it and its row from any exported CSV, the same day.
//
//   echo "<address>" | npm run leads:delete
//   npm run leads:delete -- --email-file <path outside the repository>
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import { guestAccountDeletionName } from "../../infra/leads-spec";
import { DeletionRequest, DeletionResult } from "../../packages/bff/src/leads/deletion";
import { type EmailSource, processEmailSource, readEmailInput } from "./email-input";
import { assertOperatorMachine } from "./operator-only";

export interface DeleteDeps {
  readonly lambda: Pick<LambdaClient, "send">;
  readonly functionName: string;
}

/** Invokes the deletion synchronously with the address in the payload only. */
export async function runDelete(email: string, deps: DeleteDeps): Promise<DeletionResult> {
  const payload = DeletionRequest.parse({ email, actor: "OPERATOR" });
  const output = await deps.lambda.send(new InvokeCommand({ FunctionName: deps.functionName, InvocationType: "RequestResponse", Payload: new TextEncoder().encode(JSON.stringify(payload)) }));
  if (output.FunctionError !== undefined || output.Payload === undefined) throw new Error(`GuestAccountDeletion failed (${output.FunctionError ?? "no payload"}); nothing is reported as deleted`);
  return DeletionResult.parse(JSON.parse(new TextDecoder().decode(output.Payload)));
}

export function describeOutcome(answer: DeletionResult): string {
  if (answer.outcome === "DELETED") return `deleted (lead ${answer.leadId ?? "unknown"}, ${answer.deletedUsers} Cognito user(s)); now delete the notice of that lead from the mailboxes and its row from any exported CSV`;
  if (answer.outcome === "NOTHING_TO_DELETE") return "nothing to delete (no lead for that address)";
  return "refused: that address does not belong to a guest of the own sign-up";
}

export async function main(argv: readonly string[] = process.argv.slice(2), source: EmailSource = processEmailSource, env: Readonly<Record<string, string | undefined>> = process.env): Promise<DeletionResult> {
  assertOperatorMachine(env);
  const email = await readEmailInput(argv, source);
  const [{ LambdaClient: Client }, { awsClientConfig }] = await Promise.all([import("@aws-sdk/client-lambda"), import("../../packages/bff/src/lib/clients")]);
  // The deletion runs up to 120 s (infra/leads-spec.ts); one attempt, the function is idempotent.
  const lambda = new Client(awsClientConfig({ requestTimeoutMs: 130_000, connectionTimeoutMs: 1_000, maxAttempts: 1 }));
  return runDelete(email, { lambda, functionName: guestAccountDeletionName() });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
    .then((answer) => console.log(`leads:delete: ${describeOutcome(answer)}.`))
    .catch((error: unknown) => {
      console.error(`leads:delete: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
