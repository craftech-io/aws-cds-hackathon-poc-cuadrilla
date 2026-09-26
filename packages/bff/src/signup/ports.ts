/// <reference path="../../sst-env.d.ts" />
// The dependencies of the sign-up in a Lambda, built once per container and lazily: the `Leads` table
// (its own store, outside the demo's connector), `Runtime` for the counters and the tickets, the kill
// switch reader, the HKDF subkeys of `SessionTokenKey` and node's DNS resolver. Everything comes through
// the SST link (`Resource`, never `process.env`); nothing is read before a call needs it.
import { tableClient } from "../connector/index";
import { dynamoLeadStore } from "../leads/dynamo-table";
import { ulid } from "../lib/crypto";
import { subkey } from "../lib/secrets";
import { killSwitchReader } from "../ops/defaults";
import { nodeResolver } from "./email-domain";
import type { SignupPorts } from "./start";

let defaults: SignupPorts | undefined;

export function defaultSignupPorts(): SignupPorts {
  defaults ??= {
    leads: dynamoLeadStore(),
    runtime: tableClient(),
    kill: killSwitchReader(),
    keys: { emailHash: () => subkey("email-hash"), ipHash: () => subkey("ip-hash"), ticket: () => subkey("signup-ticket") },
    resolver: nodeResolver,
    now: () => new Date(),
    newUlid: (nowMs) => ulid(nowMs),
  };
  return defaults;
}
