/// <reference path="../../sst-env.d.ts" />
// The ports of the SMS code in the BFF Lambda (ADR-0029), built once per container and lazily: `Runtime`
// and `Isps` through the connector's table client, SNS for the SMS, the `Leads` store for a sign-up
// guest's lead, the HKDF subkeys of `SessionTokenKey` and `GuestWorlds` for the world once a session
// passed. Everything comes through the SST link (`Resource`, never `process.env`).
import { tableClient } from "../connector/index";
import { lambdaProvisioner } from "../guest/provisioner";
import { ensureWorld } from "../guest/sign-in";
import { dynamoLeadStore } from "../leads/dynamo-table";
import { leadEmailHash } from "../leads/keys";
import { subkey } from "../lib/secrets";
import type { PhonePorts } from "./flow";
import type { SessionGate } from "./session";
import { snsSmsSender } from "./sms";

let defaults: Omit<PhonePorts, "gate"> | undefined;

export function defaultPhonePorts(gate: Pick<SessionGate, "forget">): PhonePorts {
  defaults ??= {
    client: tableClient(),
    sms: snsSmsSender(),
    keys: { phone: () => subkey("account-phone"), code: () => subkey("phone-code"), ip: () => subkey("ip-hash") },
    leads: dynamoLeadStore(),
    emailHash: (email) => leadEmailHash(subkey("email-hash"), email),
    afterPass: async (principal, log) => {
      await ensureWorld({ client: tableClient(), provisioner: lambdaProvisioner(), now: () => new Date(), log }, principal.sub);
    },
    now: () => new Date(),
  };
  return { ...defaults, gate };
}
