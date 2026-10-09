// `people` router of the console (docs/tool-catalog.md; FL-001, FL-007, FL-008): the world's staff, the
// crews' rosters and the poster a person uses to join the channel.
//
//   list          installers, supervisors and zone chiefs with masked contacts, allow-list state and
//                 opt-in (date and text version); never a phone or an email in clear
//   upsert        S: `upsert_person` (services/people): unique phone per world, synthetic block and
//                 email fence in guest, QA and evaluation worlds (`DENY PHONE_NOT_SYNTHETIC`,
//                 `RECIPIENT_NOT_ALLOWED`), a CONFLICT only within the world
//   deactivate    S: `deactivate_person` (or back on the list with `active: true`), with history; the
//                 open orders of a deactivated installer come back for reassignment
//   roster.get    the roster of a crew for a day (the world's day unless asked), with its history size
//   roster.set    S: `set_roster` with history; open cases keep the roster they were opened with
//   joinPoster    the poster of a person: the keyword "ALTA" and how the world's channel is reached
import { z } from "zod";
import { CalendarDate, CrewId, PersonId } from "@cuadrilla/shared";
import { StaffRole } from "../domain/people";
import { UpsertPersonInput, personView, setPersonActive, upsertPerson } from "../services/people/people";
import { SetRosterInput, setRoster } from "../services/people/roster";
import { consoleCall, inWorldTime, ownRow, worldToday } from "./console-ports";
import { type IspContext, ispProcedure, router, supervisorProcedure } from "./trpc";

/** What a person sends to join (FL-002); the poster's QR carries the same text. */
export const JOIN_KEYWORD = "ALTA";

const ListInput = z.object({ role: StaffRole.optional(), crewId: CrewId.optional() }).strict().optional();
const DeactivateInput = z.object({ personId: PersonId, active: z.boolean().optional(), reason: z.string().trim().min(1).max(200).optional() }).strict();
const RosterInput = z.object({ crewId: CrewId, date: CalendarDate.optional() }).strict();
const ByPerson = z.object({ personId: PersonId }).strict();

type Ctx = Pick<IspContext, "deps" | "world" | "principal">;

async function listPeople(ctx: Ctx, input: z.infer<typeof ListInput>) {
  const data = ctx.deps.connector;
  const roles = input?.role === undefined ? StaffRole.options : [input.role];
  const people = (await Promise.all(roles.map((role) => data.people.listPeople(ctx.world.ispId, role))))
    .flat()
    .filter((person) => person.clockId === ctx.world.clockId && (input?.crewId === undefined || person.crewId === input.crewId));
  const consents = await Promise.all(people.map((person) => data.people.getConsent(person.personId)));
  return people.map((person, index) => {
    const consent = consents[index];
    return {
      ...personView(person),
      optIn:
        consent === undefined
          ? { status: "NONE" as const }
          : { status: consent.status, medium: consent.medium, textVersion: consent.textVersion, grantedAtSim: consent.grantedAtSim ?? null, revokedAtSim: consent.revokedAtSim ?? null },
    };
  });
}

async function rosterOf(ctx: Ctx, input: z.infer<typeof RosterInput>) {
  const data = ctx.deps.connector;
  const crew = ownRow(ctx, await data.isps.getCrew(ctx.world.ispId, input.crewId), "crew");
  const date = input.date ?? (await worldToday(ctx)).day;
  const roster = await data.isps.getRoster(ctx.world.ispId, crew.crewId, date);
  if (roster === undefined || roster.clockId !== ctx.world.clockId) return { crewId: crew.crewId, crewName: crew.name, date, roster: null };
  const [primary, secondary] = await Promise.all([data.people.getPerson(roster.primaryId), data.people.getPerson(roster.secondaryId)]);
  return {
    crewId: crew.crewId,
    crewName: crew.name,
    date,
    roster: {
      primaryId: roster.primaryId,
      primaryName: primary?.firstName ?? null,
      secondaryId: roster.secondaryId,
      secondaryName: secondary?.firstName ?? null,
      startsAtSim: roster.startsAtSim,
      endsAtSim: roster.endsAtSim,
      changes: roster.history.map((entry) => ({ atSim: entry.atSim ?? null, actor: entry.actor, reason: entry.reason ?? null })),
    },
  };
}

async function posterOf(ctx: Ctx, personId: string) {
  const data = ctx.deps.connector;
  const person = ownRow(ctx, await data.people.getPerson(personId), "person");
  const settings = await data.isps.getSettings(ctx.world.ispId);
  const { ports } = consoleCall(ctx);
  const live = settings?.whatsappMode === "live" && ports.stageTransports().includes("live");
  return { personId: person.personId, firstName: person.firstName, role: person.role, keyword: JOIN_KEYWORD, qrText: JOIN_KEYWORD, channel: live ? ("live" as const) : ("simulated" as const) };
}

export const peopleRouter = router({
  list: ispProcedure.input(ListInput).query(async ({ ctx, input }) => inWorldTime(ctx, await listPeople(ctx, input))),
  upsert: supervisorProcedure.input(UpsertPersonInput).mutation(async ({ ctx, input }) => {
    const { ports, caller } = consoleCall(ctx);
    return upsertPerson({ ...ports.services, hashPhone: ports.hashPhone, addresses: ports.addresses() }, caller, input);
  }),
  deactivate: supervisorProcedure.input(DeactivateInput).mutation(async ({ ctx, input }) => {
    const { ports, caller } = consoleCall(ctx);
    return setPersonActive(ports.services, caller, { personId: input.personId, active: input.active ?? false, ...(input.reason === undefined ? {} : { reason: input.reason }) });
  }),
  roster: router({
    get: ispProcedure.input(RosterInput).query(async ({ ctx, input }) => inWorldTime(ctx, await rosterOf(ctx, input))),
    set: supervisorProcedure.input(SetRosterInput).mutation(async ({ ctx, input }) => {
      const { ports, caller } = consoleCall(ctx);
      return inWorldTime(ctx, await setRoster(ports.services, caller, input));
    }),
  }),
  joinPoster: ispProcedure.input(ByPerson).query(({ ctx, input }) => posterOf(ctx, input.personId)),
});
