// `npm run leads:unsubscribe` (ADR-0026; art. 27 of Ley 25.326): a person asked not to be contacted.
// It adds a `CONTACT` record with `accepted: false`, the real time and the version in force to the
// lead's history, records `CONTACT_WITHDRAWN` (event and lead log), and touches nothing else: the
// account, the world and the lead stay, and the lead leaves the default export. The operator's
// profile through `sst shell`, never CI; the address comes from standard input or `--email-file`.
//
//   echo "<address>" | npm run leads:unsubscribe
//   npm run leads:unsubscribe -- --email-file <path outside the repository>
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contactWithdrawal } from "../../packages/bff/src/leads/consent";
import type { LeadStore } from "../../packages/bff/src/leads/store";
import { type EmailSource, processEmailSource, readEmailInput } from "./email-input";
import { assertOperatorMachine } from "./operator-only";

export type UnsubscribeResult = { readonly outcome: "WITHDRAWN"; readonly leadId: string } | { readonly outcome: "NOT_FOUND" } | { readonly outcome: "ALREADY_WITHDRAWN"; readonly leadId: string };

export interface UnsubscribeDeps {
  readonly store: LeadStore;
  /** `leadEmailHash` with the `email-hash` subkey of the stage. */
  readonly emailHash: (email: string) => string;
  readonly now: () => Date;
}

export async function runUnsubscribe(email: string, deps: UnsubscribeDeps): Promise<UnsubscribeResult> {
  const emailHash = deps.emailHash(email);
  const lead = await deps.store.get(emailHash);
  if (lead === undefined) return { outcome: "NOT_FOUND" };
  if (!lead.consents.CONTACT.accepted) return { outcome: "ALREADY_WITHDRAWN", leadId: lead.leadId };
  const at = deps.now();
  const updated = await deps.store.withdrawContact(emailHash, contactWithdrawal(lead.locale, at), at);
  return updated === undefined ? { outcome: "NOT_FOUND" } : { outcome: "WITHDRAWN", leadId: updated.leadId };
}

export async function main(argv: readonly string[] = process.argv.slice(2), source: EmailSource = processEmailSource, env: Readonly<Record<string, string | undefined>> = process.env): Promise<UnsubscribeResult> {
  assertOperatorMachine(env);
  const email = await readEmailInput(argv, source);
  const [{ dynamoLeadStore }, { leadEmailHash }, { subkey }] = await Promise.all([
    import("../../packages/bff/src/leads/dynamo-table"),
    import("../../packages/bff/src/leads/keys"),
    import("../../packages/bff/src/lib/secrets"),
  ]);
  return runUnsubscribe(email, { store: dynamoLeadStore(), emailHash: (value) => leadEmailHash(subkey("email-hash"), value), now: () => new Date() });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
    .then((result) => console.log(`leads:unsubscribe: ${result.outcome}${"leadId" in result ? ` (lead ${result.leadId})` : ""}.`))
    .catch((error: unknown) => {
      console.error(`leads:unsubscribe: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
