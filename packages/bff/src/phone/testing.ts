// Doubles of the SMS code for tests, the local flows and the UI server (ADR-0029): ports over an
// in-memory table and `memorySmsSender`, and a gate that treats every session as passed for the
// tests of other features (never used by a Lambda: routers/deps.ts builds the real one).
import { MemoryTableClient } from "../connector/memory/table-client";
import { leadEmailHash } from "../leads/keys";
import { MemoryLeadTable } from "../leads/memory-table";
import { type LeadStore, createLeadStore } from "../leads/store";
import { TEST_MASTER_KEY, sequentialIds } from "../leads/testing";
import { deriveSubkey } from "../lib/crypto";
import type { TableClient } from "../connector/table-client";
import type { PhonePorts } from "./flow";
import { type SessionGate, createSessionGate } from "./session";
import { type MemorySmsSender, memorySmsSender } from "./sms";

/** Every session passed: the router tests of the other features. */
export function passedGate(): SessionGate {
  return { passed: async () => true, forget: () => undefined };
}

export interface MemoryPhone {
  readonly ports: PhonePorts;
  readonly sms: MemorySmsSender;
  readonly gate: SessionGate;
  readonly client: TableClient;
  readonly leads: LeadStore;
  /** Principals whose session passed and whose account then asked for its world. */
  readonly afterPass: string[];
}

export interface MemoryPhoneOptions {
  readonly client?: TableClient;
  readonly leads?: LeadStore;
  readonly now?: () => Date;
  readonly codes?: () => string;
  readonly afterPass?: PhonePorts["afterPass"];
}

const KEYS = { phone: deriveSubkey(TEST_MASTER_KEY, "account-phone"), code: deriveSubkey(TEST_MASTER_KEY, "phone-code"), ip: deriveSubkey(TEST_MASTER_KEY, "ip-hash"), email: deriveSubkey(TEST_MASTER_KEY, "email-hash") };

export function memoryPhone(options: MemoryPhoneOptions = {}): MemoryPhone {
  const client = options.client ?? new MemoryTableClient();
  const now = options.now ?? (() => new Date());
  const leads = options.leads ?? createLeadStore(new MemoryLeadTable(), { newId: sequentialIds() });
  const sms = memorySmsSender();
  const gate = createSessionGate(client, now);
  const passed: string[] = [];
  const ports: PhonePorts = {
    client,
    sms,
    keys: { phone: () => KEYS.phone, code: () => KEYS.code, ip: () => KEYS.ip },
    leads,
    emailHash: (email) => leadEmailHash(KEYS.email, email),
    gate,
    afterPass:
      options.afterPass ??
      (async (principal) => {
        passed.push(principal.userId);
      }),
    now,
    ...(options.codes === undefined ? {} : { newCode: options.codes }),
  };
  return { ports, sms, gate, client, leads, afterPass: passed };
}
