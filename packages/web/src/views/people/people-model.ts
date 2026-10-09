// What the people view derives from `people.list` and `people.roster.get` (packages/bff/src/routers/
// people.ts): the rows by role, the opt-in in words, the crews and zones on offer (the list of the world's
// people is the only source of them the console has), and the input of `people.upsert` from the form.
// Pure: tested without a browser.
import type { ConsoleRole } from "@cuadrilla/shared";
import { formatSimTime, simTimeParts } from "../../lib/world-clock";
import type { RouterInputs, RouterOutputs } from "../../lib/trpc-router";
import { copy as consoleCopy } from "../../copy/console";
import { peopleCopy } from "./copy";

export type PersonRow = RouterOutputs["people"]["list"][number];
export type StaffRole = PersonRow["role"];
export type UpsertInput = RouterInputs["people"]["upsert"];

export const STAFF_ROLES: readonly StaffRole[] = ["INSTALLER", "SUPERVISOR", "ZONE_CHIEF"];

export type RoleFilter = StaffRole | "ALL";

/** Who may add, edit, deactivate people and change a roster: supervisors and guests (`supervisorProcedure`). */
export function canManage(role: ConsoleRole | undefined): boolean {
  return role === "SUPERVISOR" || role === "GUEST";
}

const simTime = (iso: string) => formatSimTime(iso, consoleCopy.clock.weekdays);

/** "mar 13/10" for a calendar day of the world. */
export function dayLabel(date: string): string {
  const parts = simTimeParts(`${date}T12:00:00Z`);
  return `${consoleCopy.clock.weekdays[parts.weekday]} ${parts.dayMonth}`;
}

export function fullName(person: Pick<PersonRow, "firstName" | "lastName">): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

/** The opt-in of a person in words: since when and with which version of the text, or the opt-out. */
export function optInText(optIn: PersonRow["optIn"]): string {
  if (optIn.status === "NONE") return peopleCopy.optIn.none;
  if (optIn.status === "REVOKED") return optIn.revokedAtSim ? peopleCopy.optIn.revoked(simTime(optIn.revokedAtSim)) : peopleCopy.optIn.revokedUndated;
  const when = optIn.grantedAtSim ? simTime(optIn.grantedAtSim) : peopleCopy.noValue;
  const medium = peopleCopy.optIn.media[optIn.medium];
  return `${peopleCopy.optIn.granted(when, optIn.textVersion)}${medium ? ` (${medium})` : ""}`;
}

/** Installers first, then supervisors and zone chiefs, each by name. */
export function sortedPeople(people: readonly PersonRow[], filter: RoleFilter): PersonRow[] {
  return people
    .filter((person) => filter === "ALL" || person.role === filter)
    .sort((a, b) => STAFF_ROLES.indexOf(a.role) - STAFF_ROLES.indexOf(b.role) || fullName(a).localeCompare(fullName(b), "es"));
}

export function roleCounts(people: readonly PersonRow[]): Record<RoleFilter, number> {
  const counts: Record<RoleFilter, number> = { ALL: people.length, INSTALLER: 0, SUPERVISOR: 0, ZONE_CHIEF: 0 };
  for (const person of people) counts[person.role] += 1;
  return counts;
}

/** The crews of the world that have staff, in order of their id. */
export function crewsOf(people: readonly PersonRow[]): string[] {
  return [...new Set(people.flatMap((person) => (person.crewId === undefined ? [] : [person.crewId])))].sort();
}

/** The zones of the world that have staff, in order of their id. */
export function zonesOf(people: readonly PersonRow[]): string[] {
  return [...new Set(people.flatMap((person) => (person.zoneId === undefined ? [] : [person.zoneId])))].sort();
}

function capitalized(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A readable name for a zone id (`zone-norte` → "Zona Norte"): the console has no list of zones by name. */
export function zoneLabel(zoneId: string): string {
  const words = zoneId.replace(/^zone-/, "").split("-").map(capitalized).join(" ");
  return `Zona ${words}`;
}

/** A crew by the name its roster gives, or a readable fallback while the name has not arrived. */
export function crewLabel(crewId: string, names: Readonly<Record<string, string>>): string {
  return names[crewId] ?? `Equipo ${crewId.replace(/^crew-/, "").toUpperCase()}`;
}

export interface PersonForm {
  readonly role: StaffRole;
  readonly firstName: string;
  readonly lastName: string;
  readonly crewId: string;
  readonly zoneId: string;
  readonly phone: string;
  readonly email: string;
}

export function emptyForm(crews: readonly string[], zones: readonly string[]): PersonForm {
  return { role: "INSTALLER", firstName: "", lastName: "", crewId: crews[0] ?? "", zoneId: zones[0] ?? "", phone: "", email: "" };
}

export function formOf(person: PersonRow): PersonForm {
  return { role: person.role, firstName: person.firstName, lastName: person.lastName, crewId: person.crewId ?? "", zoneId: person.zoneId ?? "", phone: "", email: "" };
}

/** `+52 55 0207 0123` → `+525502070123`; anything else is left for the BFF to refuse. */
export function compactPhone(raw: string): string {
  return raw.replace(/[\s().-]/g, "");
}

/**
 * The input of `people.upsert`: a new person carries its role; an edit never sends the role and keeps the
 * stored phone and email unless new ones were typed. Field staff belong to a crew (the zone follows from
 * it); a zone chief to a zone. `undefined` while a required field is empty.
 */
export function upsertInputOf(form: PersonForm, personId: string | undefined): UpsertInput | undefined {
  const firstName = form.firstName.trim();
  const lastName = form.lastName.trim();
  if (firstName === "" || lastName === "") return undefined;
  // `null` clears: the zone of field staff always follows from the crew, so a new crew never mismatches.
  const placement = form.role === "ZONE_CHIEF" ? { zoneId: form.zoneId || null, crewId: null } : { crewId: form.crewId || null, zoneId: null };
  const phone = compactPhone(form.phone);
  const email = form.email.trim();
  return {
    ...(personId === undefined ? { role: form.role } : { personId }),
    firstName,
    lastName,
    ...placement,
    ...(phone === "" ? {} : { phone }),
    ...(email === "" ? {} : { email }),
  };
}

/** The text of a refusal of the people service, when it has one of its own. */
export function reasonText(reason: string | null): string | undefined {
  return reason === null ? undefined : peopleCopy.reasons[reason];
}
