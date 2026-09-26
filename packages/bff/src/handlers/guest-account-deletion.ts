/// <reference path="../../sst-env.d.ts" />
// `GuestAccountDeletion` (ADR-0025 §6, ADR-0026, infra/leads.ts): invoked by the `Bff`
// (`account.deleteGuest`, `{userId}` of the principal), by `LeadStream` (the expiry of a confirmed lead),
// by the `QaDriver` and by the operator (`npm run leads:delete`, `{email}`). IAM only says who may
// invoke it; the function checks its target in code (leads/deletion.ts) and answers the outcome, which
// the callers parse (`DeletionResult`). The lead log records every deletion and every refusal.
//
// Links: `Leads`, the demo tables and buckets of its row (`Isps`, `Runtime` and what the destruction of
// a generation needs), `SessionTokenKey` (the `email-hash` subkey of an `{email}` request) and `Auth`
// (the pool of `AdminDeleteUser`). Cognito is called only with the stored `gst-*` users.
import { ToolError } from "@cuadrilla/shared";
import { DynamoTableClient } from "../connector/dynamo/client";
import { createCognitoUsers } from "../leads/cognito-users";
import { type DeletionDeps, DeletionRequest, type DeletionResult, type GenerationDestroyer, deleteGuestAccount } from "../leads/deletion";
import { dynamoLeadStore } from "../leads/dynamo-table";
import { createGuestAccountPorts } from "../leads/guest-accounts";
import { leadEmailHash } from "../leads/keys";
import { dynamoDocumentClient } from "../lib/clients";
import { type Logger, createLogger } from "../lib/log";
import { subkey } from "../lib/secrets";
import { worldDestroyer } from "../leads/world-destroyer";

export function defaultDeletionDeps(log: Logger, worlds: GenerationDestroyer = worldDestroyer()): DeletionDeps {
  return {
    leads: dynamoLeadStore(),
    accounts: createGuestAccountPorts(new DynamoTableClient(dynamoDocumentClient())),
    cognito: createCognitoUsers(),
    worlds,
    emailHash: (email) => leadEmailHash(subkey("email-hash"), email),
    now: () => new Date(),
    log,
  };
}

/** One invocation: the request is validated (zod) before anything is read; a malformed one is refused. */
export async function handleGuestAccountDeletion(event: unknown, deps: DeletionDeps): Promise<DeletionResult> {
  const request = DeletionRequest.safeParse(event);
  // The zod issues may quote the payload (an email): only the refusal travels back.
  if (!request.success) throw new ToolError("INVALID", "GuestAccountDeletion takes {userId} or {email} and nothing else");
  return deleteGuestAccount(deps, request.data);
}

export async function handler(event: unknown): Promise<DeletionResult> {
  const log = createLogger({ bindings: { component: "guest-account-deletion" } });
  return handleGuestAccountDeletion(event, defaultDeletionDeps(log));
}
