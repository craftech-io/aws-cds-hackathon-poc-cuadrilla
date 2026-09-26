// Invariants of identities (docs/seed-spec.md §14): 3 every phone and email unique across the seed
// and the templates, phones only from the synthetic blocks and emails only from the SES simulator;
// 17 every person and customer synthetic by the generator's own lists; 18 the synthetic CURP.
import { curpCheckDigit } from "../generate/curp";
import { FIRST_NAMES, LAST_NAMES } from "../generate/names";
import { isSimulatorEmail, phoneBlockOf, type PhoneBlock } from "../lib/synthetic";
import type { SeedItem } from "../lib/tables";
import { entities, str, worldsOf, type SeedBundle, type SeedWorld } from "./bundle";
import { baseId, duplicates, finding, type Invariant } from "./types";

/** Blocks each world may use (docs/seed-spec.md §2): the guest template is cloned into invited, rehearsal and signup worlds. */
const WORLD_BLOCKS: Readonly<Record<SeedWorld["name"], readonly PhoneBlock[]>> = {
  demo: ["demoInstallers", "demoSupervisors", "demoCustomers", "unknownNumber"],
  guest: ["guestWorlds", "signupWorlds"],
};

const RESERVED_DOMAINS = /(?:^|\.)(?:example\.(?:com|net|org)|test|invalid|localhost|craftech\.io)$/;

interface Address {
  readonly world: SeedWorld["name"];
  readonly owner: string;
  readonly value: string;
}

function addressesOf(world: SeedWorld, unknownNumber: string | undefined): { phones: Address[]; emails: Address[] } {
  const phones: Address[] = [];
  const emails: Address[] = [];
  const add = (list: Address[], owner: string, value: unknown): void => {
    if (typeof value === "string") list.push({ world: world.name, owner, value });
  };
  for (const item of [...entities(world, "People", "Person"), ...entities(world, "People", "Customer")]) {
    const owner = str(item, "personId") || str(item, "customerId");
    add(phones, owner, item.phone);
    add(emails, owner, item.email);
  }
  for (const isp of entities(world, "Isps", "Isp")) add(emails, str(isp, "ispId"), isp.opsMailbox);
  for (const user of entities(world, "Isps", "ConsoleUser")) add(emails, str(user, "userId"), user.email);
  if (unknownNumber !== undefined) add(phones, "unknown number", unknownNumber);
  return { phones, emails };
}

function uniqueAddresses(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  const unknown = { demo: bundle.demo?.unknownNumber, guest: bundle.guest?.unknownNumber };
  const all = worldsOf(bundle).map((world) => addressesOf(world, unknown[world.name]));
  const phones = all.flatMap((entry) => entry.phones);
  const emails = all.flatMap((entry) => entry.emails);
  for (const value of duplicates(phones.map((phone) => phone.value))) errors.push(`phone ${value} used more than once`);
  for (const value of duplicates(emails.map((email) => email.value))) errors.push(`email ${value} used more than once`);
  for (const phone of phones) {
    const block = phoneBlockOf(phone.value);
    if (block === undefined || !WORLD_BLOCKS[phone.world].includes(block)) errors.push(`${phone.world} ${phone.owner}: phone outside the synthetic blocks of its world`);
  }
  for (const email of emails) {
    const domain = email.value.slice(email.value.indexOf("@") + 1);
    if (!isSimulatorEmail(email.value) || RESERVED_DOMAINS.test(domain)) errors.push(`${email.world} ${email.owner}: email outside the SES mailbox simulator`);
  }
  return errors;
}

function syntheticPeople(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  const first = new Set<string>(FIRST_NAMES);
  const last = new Set<string>(LAST_NAMES);
  const check = (world: string, item: SeedItem, owner: string): void => {
    if (!first.has(str(item, "firstName")) || !last.has(str(item, "lastName"))) errors.push(`${world} ${owner}: name outside the generator's lists`);
  };
  for (const world of worldsOf(bundle)) {
    for (const person of entities(world, "People", "Person")) check(world.name, person, str(person, "personId"));
    for (const customer of entities(world, "People", "Customer")) check(world.name, customer, str(customer, "customerId"));
  }
  for (const model of bundle.models?.models ?? []) {
    if (!first.has(model.installer.firstName) || !last.has(model.installer.lastName)) errors.push(`models ${model.model}: installer name outside the lists`);
    if (!first.has(model.customer.firstName) || !last.has(model.customer.lastName)) errors.push(`models ${model.model}: customer name outside the lists`);
  }
  return errors;
}

const CURP = /\b([A-Z]{4})(\d{6})([HMX])([A-Z]{2})([A-Z]{3})([A-Z0-9])(\d)\b/;

function syntheticCurp(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  for (const world of worldsOf(bundle)) {
    const customer = entities(world, "People", "Customer").find((item) => baseId(str(item, "customerId")) === "cust-10425");
    const match = CURP.exec(str(customer ?? {}, "note"));
    if (customer === undefined || match === null) {
      errors.push(`${world.name}: cust-10425 has no synthetic CURP in its note`);
      continue;
    }
    const [curp = "", , birth, , state] = match;
    if (birth !== "000101" || state !== "NE") errors.push(`${world.name}: the synthetic CURP is not dated 1900-01-01 in state NE`);
    if (curpCheckDigit(curp.slice(0, 17)) === Number(curp.slice(17))) errors.push(`${world.name}: the synthetic CURP has a valid check digit`);
  }
  return errors;
}

export const IDENTITY_INVARIANTS: readonly Invariant[] = [
  { id: 3, title: "Unique phones and emails; phones of the synthetic blocks, emails of the SES simulator", check: (bundle) => finding(uniqueAddresses(bundle)) },
  { id: 17, title: "People and customers synthetic by the generator's lists", check: (bundle) => finding(syntheticPeople(bundle)) },
  { id: 18, title: "Synthetic CURP of cust-10425: valid format, 1900-01-01, NE, wrong check digit", check: (bundle) => finding(syntheticCurp(bundle)) },
];
