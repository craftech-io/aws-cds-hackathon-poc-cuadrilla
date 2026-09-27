/// <reference path="../../sst-env.d.ts" />
// What the post confirmation and post authentication triggers share in a Lambda: the tables by their
// links, the `Leads` store, the lead key's `email-hash` subkey of `SessionTokenKey` and the invocation
// of `GuestWorlds`. Built once per container.
import { tableClient } from "../connector/index";
import type { TableClient } from "../connector/table-client";
import { type WorldProvisioner, lambdaProvisioner } from "../guest/provisioner";
import { dynamoLeadStore } from "../leads/dynamo-table";
import { leadEmailHash } from "../leads/keys";
import type { LeadStore } from "../leads/store";
import { subkey } from "../lib/secrets";

export interface GuestFlowDeps {
  readonly client: TableClient;
  readonly leads: LeadStore;
  readonly emailHash: (email: string) => string;
  readonly provisioner: WorldProvisioner;
  /** Real clock. */
  readonly now: () => Date;
}

let linked: GuestFlowDeps | undefined;

export function linkedGuestFlowDeps(): GuestFlowDeps {
  linked ??= {
    client: tableClient(),
    leads: dynamoLeadStore(),
    emailHash: (email) => leadEmailHash(subkey("email-hash"), email),
    provisioner: lambdaProvisioner(),
    now: () => new Date(),
  };
  return linked;
}
