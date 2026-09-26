// What makes a phone or an email synthetic (docs/seed-spec.md §2): Mexico City numbers whose local
// part starts with 0, which the numbering plan does not assign to subscribers, in one block per use;
// and addresses of the SES mailbox simulator, so nothing the demo sends reaches a person. The
// generator builds addresses with these blocks, the validator checks every one against them
// (invariants 3 and 17) and the world factory takes a guest world's block from `guestBlock`.
import { z } from "zod";

/** Country and area code of every synthetic phone: Mexico, Mexico City. */
export const PHONE_PREFIX = "+5255";

/** The blocks of docs/seed-spec.md §2, as the national number after `+52 55`. */
export const PHONE_BLOCKS = {
  demoInstallers: { label: "+52 55 0101 00xx", pattern: /^\+5255010100\d{2}$/ },
  demoSupervisors: { label: "+52 55 0102 00xx", pattern: /^\+5255010200\d{2}$/ },
  demoCustomers: { label: "+52 55 0103 0xxx", pattern: /^\+52550103[0]\d{3}$/ },
  unknownNumber: { label: "+52 55 0199 0001", pattern: /^\+525501990001$/ },
  /** A world of an invited guest (`INVITED`) or of the operator's rehearsal (`TEST`, `nn = 99`): one block per world. */
  guestWorlds: { label: "+52 55 02nn 0xxx", pattern: /^\+525502\d{2}0\d{3}$/ },
  /** Every world of an own signup (`SIGNUP`, ADR-0025) shares one block: an identity is unique per world. */
  signupWorlds: { label: "+52 55 0300 0xxx", pattern: /^\+525503000\d{3}$/ },
  qaLeases: { label: "+52 55 09xx xxxx", pattern: /^\+525509\d{6}$/ },
} as const;
export type PhoneBlock = keyof typeof PHONE_BLOCKS;

/** Block a phone belongs to, or `undefined` when it is outside every synthetic block. */
export function phoneBlockOf(phone: string): PhoneBlock | undefined {
  return (Object.keys(PHONE_BLOCKS) as PhoneBlock[]).find((block) => PHONE_BLOCKS[block].pattern.test(phone));
}

/** The simulator of SES mailboxes: `success+…`, `bounce+…`, `complaint+…` (docs/architecture-integrations.md §1). */
export const SIMULATOR_DOMAIN = "simulator.amazonses.com";
export const SimulatorOutcome = z.enum(["success", "bounce", "complaint"]);
export type SimulatorOutcome = z.infer<typeof SimulatorOutcome>;

export function simulatorEmail(outcome: SimulatorOutcome, label: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)) throw new RangeError(`invalid simulator label "${label}"`);
  return `${outcome}+${label}@${SIMULATOR_DOMAIN}`;
}

const SIMULATOR_ADDRESS = new RegExp(`^(success|bounce|complaint)\\+[a-z0-9]+(?:-[a-z0-9]+)*@${SIMULATOR_DOMAIN.replace(/\./g, "\\.")}$`);

export function isSimulatorEmail(email: string): boolean {
  return SIMULATOR_ADDRESS.test(email);
}

/**
 * Tokens of an invited guest's copy of the `guest` template (docs/seed-spec.md §2-§3): its number in
 * ids (`inst-rogelio-g07`, `wo-24817-g07`), its operator and clock, and its phone block `+52 55 02nn`
 * (`test`, the operator's rehearsal world, takes `99`).
 */
export function guestBlock(guest: number | "test"): { readonly number: string; readonly clockTag: string; readonly phoneBlock: string } {
  if (guest !== "test" && (!Number.isInteger(guest) || guest < 0 || guest > 98)) throw new RangeError(`guest number out of range: ${guest}`);
  const number = guest === "test" ? "test" : String(guest).padStart(2, "0");
  return { number, clockTag: `g${number}`, phoneBlock: `${PHONE_PREFIX}02${guest === "test" ? "99" : number}` };
}
