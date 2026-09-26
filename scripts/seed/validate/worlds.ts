// Invariants of the work of a world (docs/seed-spec.md §14): 1 checklist, ONU and history of every
// order; 2 numbers, serials and story photos; 4 opt-in of the people who receive WhatsApp; 5 rosters
// and zone chiefs; 19 the guest template's tour window, scenes and day-start timers.
import { ChecklistItem, WORK_ORDER_NUMBER_RANGES } from "@cuadrilla/shared";
import { SAMPLE_GUEST_TOKENS } from "../generate/guest-template";
import { DAYS, DAY_START_TIME, sim } from "../generate/time";
import type { SeedItem } from "../lib/tables";
import { entities, str, worldsOf, type SeedBundle, type SeedWorld } from "./bundle";
import { baseId, duplicates, finding, type Invariant } from "./types";

const ordersOf = (world: SeedWorld, date?: string): SeedItem[] => entities(world, "WorkOrders", "WorkOrder").filter((order) => date === undefined || order.date === date);
const partitionOf = (world: SeedWorld, workOrderId: string): SeedItem[] => world.tables.WorkOrders.filter((item) => item.PK === `WO#${workOrderId}`);

function orderStructure(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  for (const world of worldsOf(bundle)) {
    const onus = world.tables.Network;
    for (const order of ordersOf(world)) {
      const id = str(order, "workOrderId");
      const items = partitionOf(world, id);
      const checks = items.filter((item) => item.entity === "ChecklistItem");
      const rows = onus.filter((onu) => onu.serial === order.onuSerial);
      if (rows.length !== 1 || typeof rows[0]?.behaviour !== "string") errors.push(`${world.name} ${id}: ${rows.length} Network rows with a behaviour for its ONU`);
      if (order.date === DAYS.history) {
        if (order.status !== "CLOSED") errors.push(`${world.name} ${id}: an order of 12/10 is ${String(order.status)}`);
        const certificate = items.find((item) => item.entity === "Certificate");
        if (certificate?.content === undefined) errors.push(`${world.name} ${id}: no certificate content`);
        if (certificate?.sha256 !== undefined || certificate?.s3Key !== undefined) errors.push(`${world.name} ${id}: the seed carries a certificate PDF`);
        const evidence = new Set(items.filter((item) => item.entity === "Evidence").map((item) => item.evidenceId));
        for (const check of checks) {
          if (check.status !== "PASSED" && check.status !== "OVERRIDDEN") errors.push(`${world.name} ${id}: ${String(check.item)} is ${String(check.status)}`);
          if (check.evidenceId !== undefined && !evidence.has(check.evidenceId)) errors.push(`${world.name} ${id}: ${String(check.item)} points to a missing evidence`);
        }
        if (checks.length !== ChecklistItem.options.length) errors.push(`${world.name} ${id}: ${checks.length} checklist items`);
        continue;
      }
      const pending = checks.filter((check) => check.status === "PENDING");
      const items5 = new Set(checks.map((check) => check.item));
      if (checks.length !== 5 || pending.length !== 5 || ChecklistItem.options.some((item) => !items5.has(item))) errors.push(`${world.name} ${id}: the five CHECK# are not all PENDING`);
    }
  }
  return errors;
}

function numbersAndSerials(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  const range = WORK_ORDER_NUMBER_RANGES.demo;
  for (const world of worldsOf(bundle)) {
    const orders = ordersOf(world);
    for (const number of duplicates(orders.map((order) => str(order, "workOrderNumber")))) errors.push(`${world.name}: work order number ${number} repeated`);
    for (const serial of duplicates(orders.map((order) => str(order, "onuSerial")))) errors.push(`${world.name}: ONU serial ${serial} repeated`);
    for (const order of orders) {
      const number = Number(order.workOrderNumber);
      if (number < range.min || number > range.max) errors.push(`${world.name}: work order ${number} outside ${range.min}-${range.max}`);
    }
  }
  const [demo] = worldsOf(bundle);
  if (demo === undefined) return errors;
  const serialOf = new Map(ordersOf(demo).map((order) => [str(order, "workOrderId"), str(order, "onuSerial")]));
  for (const photo of [...bundle.media.set, ...bundle.media.aux.photos.filter((entry) => entry.group === "hist")]) {
    if (photo.workOrderId === null) continue;
    const serial = serialOf.get(photo.workOrderId);
    if (serial === undefined) {
      errors.push(`${photo.photoId}: its order ${photo.workOrderId} is not in the seed`);
      continue;
    }
    if (photo.orderSerial !== serial) errors.push(`${photo.photoId}: labelled against serial ${photo.orderSerial}, the order has ${serial}`);
    const storyLabel = photo.drawn.template === "label" && photo.expectedVerdict === "PASS";
    if (storyLabel && photo.drawn.template === "label" && photo.drawn.serial !== serial && photo.workOrderId !== "wo-24821") errors.push(`${photo.photoId}: its label shows ${photo.drawn.serial}, not the serial of ${photo.workOrderId}`);
  }
  return errors;
}

const OPT_IN_EXCEPTIONS: Readonly<Record<string, "NONE" | "REVOKED">> = { "inst-julian": "NONE", "inst-ernesto": "REVOKED" };

function optIn(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  for (const world of worldsOf(bundle)) {
    const consent = new Map(entities(world, "People", "Consent").map((item) => [str(item, "personId"), str(item, "status")]));
    const recipients = new Set([
      ...ordersOf(world, DAYS.demo).map((order) => str(order, "installerId")),
      ...entities(world, "Isps", "ShiftRoster").flatMap((roster) => [str(roster, "primaryId"), str(roster, "secondaryId")]),
    ]);
    for (const personId of recipients) {
      const status = consent.get(personId) ?? "NONE";
      const expected = OPT_IN_EXCEPTIONS[baseId(personId)] ?? "GRANTED";
      if (status !== expected) errors.push(`${world.name} ${personId}: opt-in ${status}, expected ${expected}`);
    }
  }
  return errors;
}

function rosters(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  for (const world of worldsOf(bundle)) {
    const people = new Map(entities(world, "People", "Person").map((person) => [str(person, "personId"), person]));
    const roster = entities(world, "Isps", "ShiftRoster");
    const days = new Set(ordersOf(world).map((order) => `${str(order, "crewId")}|${str(order, "date")}`));
    for (const day of days) {
      const [crewId, date] = day.split("|");
      const found = roster.find((item) => item.crewId === crewId && item.date === date);
      if (found === undefined) {
        errors.push(`${world.name}: no roster of ${crewId} on ${date}`);
        continue;
      }
      const ids = [str(found, "primaryId"), str(found, "secondaryId")];
      if (ids[0] === ids[1]) errors.push(`${world.name}: roster of ${crewId} on ${date} has the same supervisor twice`);
      for (const id of ids) {
        const person = people.get(id);
        if (person?.role !== "SUPERVISOR" || person.crewId !== crewId) errors.push(`${world.name}: ${id} of the roster of ${crewId} is not a supervisor of that crew`);
      }
    }
    for (const zone of entities(world, "Isps", "Zone")) {
      const chief = people.get(str(zone, "zoneChiefId"));
      if (chief?.role !== "ZONE_CHIEF" || chief.zoneId !== zone.zoneId) errors.push(`${world.name}: ${String(zone.zoneId)} has no zone chief`);
    }
  }
  return errors;
}

function dayStarts(world: SeedWorld): string[] {
  const errors: string[] = [];
  const due = Date.parse(sim(DAYS.demo, DAY_START_TIME));
  const timers = [...world.tables.WorkOrders, ...world.tables.People].filter((item) => item.entity === "Timer");
  for (const installer of entities(world, "People", "Person").filter((person) => person.role === "INSTALLER" && person.active === true)) {
    const id = str(installer, "personId");
    const own = timers.filter((timer) => timer.kind === "DAY_START" && (timer.payload as { installerId?: string } | undefined)?.installerId === id);
    if (own.length !== 1 || Date.parse(str(own[0] ?? {}, "dueAtSim")) !== due || own[0]?.status !== "SCHEDULED") errors.push(`${world.name} ${id}: expected one SCHEDULED DAY_START at 07:30 of 13/10`);
  }
  return errors;
}

function guestTour(bundle: SeedBundle): string[] {
  const errors = worldsOf(bundle).flatMap(dayStarts);
  const guest = bundle.guest;
  if (guest?.tour === undefined || guest.scenes === undefined) return [...errors, "guest: the template declares no tour or no scenes"];
  const tag = `-${SAMPLE_GUEST_TOKENS.clockTag}`;
  const idFields: ReadonlyArray<readonly [string, string]> = [
    ["Person", "personId"],
    ["Customer", "customerId"],
    ["WorkOrder", "workOrderId"],
  ];
  for (const item of [...guest.tables.People, ...guest.tables.WorkOrders]) {
    const field = idFields.find(([entity]) => entity === item.entity)?.[1];
    if (field !== undefined && !str(item, field).endsWith(tag)) errors.push(`guest: ${str(item, field)} does not carry the tag of its world`);
  }
  const { windowStartSim, windowEndSim } = guest.tour;
  const inWindow = (instant: string): boolean => Date.parse(instant) >= Date.parse(windowStartSim) && Date.parse(instant) <= Date.parse(windowEndSim);
  const timers = [...guest.tables.WorkOrders, ...guest.tables.People, ...guest.tables.Cases].filter((item) => item.entity === "Timer");
  for (const timer of timers) if (timer.kind !== "DAY_START" && inWindow(str(timer, "dueAtSim"))) errors.push(`guest: timer ${String(timer.timerId)} inside the tour window`);
  const orders = new Map(guest.tables.WorkOrders.filter((item) => item.entity === "WorkOrder").map((order) => [str(order, "workOrderId"), order]));
  const installers = new Set(guest.tables.People.filter((item) => item.entity === "Person" && item.role === "INSTALLER").map((person) => str(person, "personId")));
  for (const id of guest.tour.workOrderIds) if (orders.get(id)?.installerId !== guest.tour.installerId) errors.push(`guest: tour order ${id} is not an order of ${guest.tour.installerId}`);
  for (const track of ["express", "full"] as const) {
    for (const step of duplicates(guest.scenes.flatMap((scene) => scene.steps[track]))) errors.push(`guest: step ${step} of the ${track} tour has two scenes`);
  }
  for (const scene of guest.scenes) {
    if (!inWindow(scene.advanceToSim)) errors.push(`guest scene ${scene.sceneId}: ${scene.advanceToSim} outside the tour window`);
    if (!installers.has(scene.installer.personId)) errors.push(`guest scene ${scene.sceneId}: unknown installer ${scene.installer.personId}`);
    const active = scene.installer.activeWorkOrderId;
    if (active !== undefined && orders.get(active)?.installerId !== scene.installer.personId) errors.push(`guest scene ${scene.sceneId}: active order ${active} is not the installer's`);
    for (const id of Object.keys(scene.orders)) if (!orders.has(id)) errors.push(`guest scene ${scene.sceneId}: unknown order ${id}`);
  }
  return errors;
}

export const WORLD_INVARIANTS: readonly Invariant[] = [
  { id: 1, title: "Orders of 13/10 with five PENDING items and one ONU; orders of 12/10 with certificate content and evidence", check: (bundle) => finding(orderStructure(bundle)) },
  { id: 2, title: "Unique numbers in range and serials; serials of the story photos", check: (bundle) => finding(numbersAndSerials(bundle)) },
  { id: 4, title: "Opt-in of everyone who receives WhatsApp, except inst-julian and inst-ernesto", check: (bundle) => finding(optIn(bundle)) },
  { id: 5, title: "Roster with two supervisors of the crew for every day with orders; a chief per zone", check: (bundle) => finding(rosters(bundle)) },
  { id: 19, title: "Guest template: DAY_START per active installer, no other timer in the tour window, scenes that exist", check: (bundle) => finding(guestTour(bundle)) },
];
