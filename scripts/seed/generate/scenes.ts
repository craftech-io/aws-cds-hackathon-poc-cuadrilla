// The guided tour on the `guest` template (docs/design-brief.md §15, docs/seed-spec.md §3): the tour
// window of 13/10 (07:00-15:30) over Rogelio's three orders, and one scene of "Saltar a escena" before
// every step that needs one, so no step depends on earlier turns of the model. A scene resets the
// world, advances the clock to its instant firing the due timers in order (the 07:30 day start) and
// seeds its presets through the product's repositories (docs/tool-catalog.md, `world.create`); the
// agent-only buttons ("Cerrar instalación") are seeded with `offer`, evidence with seeding renders.
// Each scene sits just before its moment of the main story (packages/bff/src/story/main-story.ts), so
// "Checklist completo" is at 10:00 and the certificate goes out at 10:05, as in docs/design-brief.md §4.
import type { Scene, Tour } from "../lib/worlds";
import { DAYS, TOUR_WINDOW, addMinutes, sim } from "./time";
import type { WorldSpec } from "./world";

const at = (time: string): string => sim(DAYS.demo, time);

export function guestTour(world: WorldSpec): Tour {
  return {
    installerId: world.personId("inst-rogelio"),
    workOrderIds: ["24817", "24818", "24819"].map((number) => world.workOrderId(number)),
    windowStartSim: TOUR_WINDOW.start,
    windowEndSim: TOUR_WINDOW.end,
  };
}

export function guestScenes(world: WorldSpec): Scene[] {
  const personId = world.personId("inst-rogelio");
  const [first, second, third] = ["24817", "24818", "24819"].map((number) => world.workOrderId(number)) as [string, string, string];
  const onSite = (time: string, activeWorkOrderId: string) => ({ personId, activeWorkOrderId, lastInboundAtSim: addMinutes(at(time), -3) });
  const lowPowerSteps = [1, 2, 3].map(() => ({ symptom: "LOW_POWER" as const, stepRef: "DIAG-03", outcome: "NO_CHANGE" as const }));
  return [
    {
      sceneId: "inicio-del-dia",
      title: { es: "Inicio del día (07:00)", en: "Start of the day (07:00)" },
      steps: { express: [], full: ["2"] },
      advanceToSim: at("07:00"),
      installer: { personId },
      orders: {},
      description: "The world as the guest first sees it: clock paused at 07:00, every day start pending at 07:30.",
    },
    {
      sceneId: "ordenes-del-dia",
      title: { es: "Órdenes del día (07:30)", en: "Orders of the day (07:30)" },
      steps: { express: [], full: ["3"] },
      advanceToSim: at("07:30"),
      installer: { personId },
      orders: {},
      description: "The day start fired: Rogelio has the ordenes_del_dia template with its Ver órdenes button.",
    },
    {
      sceneId: "en-sitio-0920",
      title: { es: "En sitio (09:20)", en: "On site (09:20)" },
      steps: { express: ["X1"], full: ["4"] },
      advanceToSim: at("09:20"),
      installer: onSite("09:20", first),
      orders: { [first]: { onu: { behaviour: "LOS_THEN_ONLINE", fixed: false } } },
      description: "First visit: the ONU of 24817 reports LOS until the installer acts.",
    },
    {
      sceneId: "paso-de-diagnostico",
      title: { es: "Paso de diagnóstico indicado (09:25)", en: "Troubleshooting step given (09:25)" },
      steps: { express: [], full: ["5"] },
      advanceToSim: at("09:25"),
      installer: onSite("09:25", first),
      orders: { [first]: { onu: { behaviour: "LOS_THEN_ONLINE", fixed: false }, steps: [{ symptom: "NO_PON_LIGHT", stepRef: "DIAG-02", outcome: "PENDING" }] } },
      description: "The agent asked to clean the SC/APC connectors (§DIAG-02); the next installer message is the physical action that brings the ONU online.",
    },
    {
      sceneId: "onu-en-linea",
      title: { es: "ONU en línea (09:35)", en: "ONU online (09:35)" },
      steps: { express: [], full: ["6"] },
      advanceToSim: at("09:35"),
      installer: onSite("09:35", first),
      orders: { [first]: { onu: { behaviour: "LOS_THEN_ONLINE", fixed: true }, steps: [{ symptom: "NO_PON_LIGHT", stepRef: "DIAG-02", outcome: "FIXED" }], checklist: { ONU_ONLINE: { status: "PASSED" } } } },
      description: "The ONU of 24817 is online at −21.4 dBm (B+): the policy question comes next.",
    },
    {
      sceneId: "evidencia",
      title: { es: "Evidencia (09:45)", en: "Evidence (09:45)" },
      steps: { express: ["X2"], full: ["7"] },
      advanceToSim: at("09:45"),
      installer: onSite("09:45", first),
      orders: { [first]: { onu: { behaviour: "LOS_THEN_ONLINE", fixed: true }, checklist: { ONU_ONLINE: { status: "PASSED" } } } },
      description: "The ONU is online and the three photos and the customer's conformity are pending.",
    },
    {
      sceneId: "checklist-completo",
      title: { es: "Checklist completo (10:00)", en: "Checklist complete (10:00)" },
      steps: { express: ["X3"], full: ["8"] },
      advanceToSim: at("10:00"),
      installer: onSite("10:00", first),
      orders: {
        [first]: {
          onu: { behaviour: "LOS_THEN_ONLINE", fixed: true },
          checklist: {
            ONU_ONLINE: { status: "PASSED" },
            POWER_READING_PHOTO: { status: "PASSED" },
            ONU_LABEL_PHOTO: { status: "PASSED" },
            ROSETTE_PHOTO: { status: "PASSED" },
            CUSTOMER_OK: { status: "PASSED" },
          },
          offer: [{ action: "CLOSE_INSTALLATION" }],
        },
      },
      description: "Every item of 24817 validated (seeding renders, never photos of the set) and the Cerrar instalación button already offered.",
    },
    {
      sceneId: "segunda-visita-1150",
      title: { es: "Segunda visita (11:50)", en: "Second visit (11:50)" },
      steps: { express: [], full: ["9"] },
      advanceToSim: at("11:50"),
      installer: onSite("11:50", second),
      orders: { [second]: { onu: { behaviour: "LOW_POWER_THEN_OK", fixed: false } } },
      description: "The ONU of 24818 reads −29.8 dBm, out of B+, and no installer step fixes it.",
    },
    {
      sceneId: "caso-con-supervisora",
      title: { es: "Caso con la supervisora de turno (11:50)", en: "Case with the supervisor on duty (11:50)" },
      steps: { express: [], full: ["10"] },
      advanceToSim: at("11:50"),
      installer: onSite("11:50", second),
      orders: { [second]: { onu: { behaviour: "LOW_POWER_THEN_OK", fixed: false }, steps: lowPowerSteps, case: { reason: "DIAGNOSIS_ATTEMPTS", rung: "PRIMARY", status: "OPEN" } } },
      description: "Three steps without change opened a DIAGNOSIS_ATTEMPTS case; Adriana has caso_escalado and the rung times out at 12:00.",
    },
    {
      sceneId: "caso-con-respaldo",
      title: { es: "Caso con el supervisor de respaldo (12:00)", en: "Case with the backup supervisor (12:00)" },
      steps: { express: [], full: ["11"] },
      advanceToSim: at("12:00"),
      installer: onSite("12:00", second),
      orders: { [second]: { onu: { behaviour: "LOW_POWER_THEN_OK", fixed: false }, steps: lowPowerSteps, case: { reason: "DIAGNOSIS_ATTEMPTS", rung: "SECONDARY", status: "OPEN" } } },
      description: "The case moved to Héctor with caso_reasignado; his instruction over the bridge fixes the power.",
    },
    {
      sceneId: "tercera-visita-1510",
      title: { es: "Tercera visita (15:10)", en: "Third visit (15:10)" },
      steps: { express: ["X4"], full: ["12"] },
      advanceToSim: at("15:10"),
      installer: onSite("15:10", third),
      orders: {},
      description: "Third visit: the installer reports a hazard and receives the fixed instruction of §SEG-01.",
    },
  ];
}
