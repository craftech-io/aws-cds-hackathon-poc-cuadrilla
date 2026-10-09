// The guided tour (docs/design-brief.md §15), single source of what people read about it: the
// "Recorrido guiado" panel of the console (es/en), the "Guided tour" of the README (English, written
// between its markers by `npm run tour:check -- --write`) and the steps SC-18 walks (it imports this
// module). The buttons themselves are data of the BFF (`packages/bff/src/routers/tour.ts`, `TOURS`:
// the parts `tour.run` executes); `npm run tour:check` fails when the ids, scenes or waits of the two
// differ, when the scenes differ from the `guest` template, or when the README or SC-18 drift.
//
// The tour follows Rogelio's day of 13/10 (07:00-15:30): the start of the day at 07:30, the first
// visit at 09:20, the certificate at 10:00, the case at 11:50 that times out at 12:00 and the hazard at
// 15:10. The hours of "Qué mirar" are placeholders (`{dayStart}`): the panel fills them from the
// world's pending timers (`tour.steps` → `upcoming`) and the README from the expected values declared
// here; scripts/tour/timeline.test.ts walks the steps over the `guest` template to prove they are the
// real ones. Pure data and pure functions: the script and the tests import it in Node.
import type { TimerKind } from "@cuadrilla/shared";

export type TourLang = "es" | "en";

export interface Bilingual {
  readonly es: string;
  readonly en: string;
}

export const TOUR_TRACK_IDS = ["EXPRESS", "FULL"] as const;
export type TourTrackId = (typeof TOUR_TRACK_IDS)[number];

/** The day and the window of the tour in the `guest` template (docs/seed-spec.md §3). */
export const TOUR_DAY = "2026-10-13";
const OFFSET = "-06:00";
export const TOUR_WINDOW = { startSim: `${TOUR_DAY}T07:00:00${OFFSET}`, endSim: `${TOUR_DAY}T15:30:00${OFFSET}` } as const;

/** A simulated instant of the tour's day, `HH:MM` in the world's time (America/Mexico_City, −06:00). */
export function tourSim(time: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError(`not a time: ${time}`);
  return `${TOUR_DAY}T${time}:00${OFFSET}`;
}

/** `HH:MM` of an instant written with its offset (the world's wall time, read from the string). */
export function wallTime(instant: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(instant);
  if (!match) throw new RangeError(`not an instant: ${instant}`);
  return `${match[1]}:${match[2]}`;
}

export interface TourTrack {
  readonly id: TourTrackId;
  readonly title: Bilingual;
  /** What the tour takes, reading included (docs/design-brief.md §15). */
  readonly minutes: number;
}

export const TOUR_TRACKS: Readonly<Record<TourTrackId, TourTrack>> = {
  EXPRESS: { id: "EXPRESS", title: { es: "Recorrido exprés", en: "Express tour" }, minutes: 5 },
  FULL: { id: "FULL", title: { es: "Recorrido completo", en: "Full tour" }, minutes: 15 },
};

/** A scene of "Saltar a escena": the seeded state of the `guest` template just before a step. */
export interface TourScene {
  readonly sceneId: string;
  readonly title: Bilingual;
  readonly atSim: string;
}

export const TOUR_SCENES: readonly TourScene[] = [
  { sceneId: "inicio-del-dia", title: { es: "Inicio del día (07:00)", en: "Start of the day (07:00)" }, atSim: tourSim("07:00") },
  { sceneId: "ordenes-del-dia", title: { es: "Órdenes del día (07:30)", en: "Orders of the day (07:30)" }, atSim: tourSim("07:30") },
  { sceneId: "en-sitio-0920", title: { es: "En sitio (09:20)", en: "On site (09:20)" }, atSim: tourSim("09:20") },
  { sceneId: "paso-de-diagnostico", title: { es: "Paso de diagnóstico indicado (09:25)", en: "Troubleshooting step given (09:25)" }, atSim: tourSim("09:25") },
  { sceneId: "onu-en-linea", title: { es: "ONU en línea (09:35)", en: "ONU online (09:35)" }, atSim: tourSim("09:35") },
  { sceneId: "evidencia", title: { es: "Evidencia (09:45)", en: "Evidence (09:45)" }, atSim: tourSim("09:45") },
  { sceneId: "checklist-completo", title: { es: "Checklist completo (10:00)", en: "Checklist complete (10:00)" }, atSim: tourSim("10:00") },
  { sceneId: "segunda-visita-1150", title: { es: "Segunda visita (11:50)", en: "Second visit (11:50)" }, atSim: tourSim("11:50") },
  { sceneId: "caso-con-supervisora", title: { es: "Caso con la supervisora de turno (11:50)", en: "Case with the supervisor on duty (11:50)" }, atSim: tourSim("11:50") },
  { sceneId: "caso-con-respaldo", title: { es: "Caso con el supervisor de respaldo (12:00)", en: "Case with the backup supervisor (12:00)" }, atSim: tourSim("12:00") },
  { sceneId: "tercera-visita-1510", title: { es: "Tercera visita (15:10)", en: "Third visit (15:10)" }, atSim: tourSim("15:10") },
];

export function sceneOf(sceneId: string): TourScene | undefined {
  return TOUR_SCENES.find((scene) => scene.sceneId === sceneId);
}

/** A time of "Qué mirar": the next pending timer of this kind, or the expected hour while none is pending. */
export interface TourTime {
  readonly timer: TimerKind;
  readonly expectedSim: string;
}

export interface TourStep {
  /** The id `tour.run` and SC-18 know the step by (`X1`, `4`). */
  readonly stepId: string;
  readonly title: Bilingual;
  /** What the step's button does. */
  readonly action: Bilingual;
  /** "Qué mirar", with `{name}` placeholders declared in `times`. */
  readonly look: Bilingual;
  readonly times: Readonly<Record<string, TourTime>>;
  readonly wait: Bilingual;
  /** Real seconds the step expects to wait: the same as the BFF's step. */
  readonly waitSec: number;
  /** The scene of "Saltar a escena" that prepares the step; `null` when it needs none. */
  readonly sceneId: string | null;
  /** Where the clock stands after the step's clock move (and the timer it lands on, if any). */
  readonly lands?: { readonly simNow: string; readonly timer?: TimerKind };
}

const dayStart: TourTime = { timer: "DAY_START", expectedSim: tourSim("07:30") };
const caseTimeout: TourTime = { timer: "CASE_TIMEOUT", expectedSim: tourSim("12:00") };

const LOOK = {
  voice: {
    es: "Acuse de lectura y «escribiendo…» al instante; después, la transcripción, el estado sin señal óptica que reporta el orquestador y el paso del manual con la cita §DIAG-02.",
    en: "Read receipt and “typing…” right away; then the transcript, the no-optical-signal state the orchestrator reports and the manual step citing §DIAG-02.",
  },
  certificate: {
    es: "El PDF del acta en el simulador; en el buzón de salida, los dos emails (cliente y operaciones) con su evento de entrega.",
    en: "The certificate PDF in the simulator; in the outbox, the two emails (customer and operations) with their delivery event.",
  },
  hazard: {
    es: "La instrucción de seguridad de §SEG-01 al instante, la alerta de seguridad a Adriana y el email al jefe de zona en el buzón de salida.",
    en: "The safety instruction of §SEG-01 right away, the safety alert to Adriana and the email to the zone chief in the outbox.",
  },
} as const satisfies Record<string, Bilingual>;

const WAIT = {
  voice: { es: "~45 s (transcripción + turno del agente)", en: "~45 s (transcription + agent turn)" },
  turn: { es: "~30 s (turno del agente)", en: "~30 s (agent turn)" },
  photo: { es: "~20 s por foto", en: "~20 s per photo" },
  certificate: { es: "~60 s (PDF + emails)", en: "~60 s (PDF + emails)" },
  quick: { es: "~20 s", en: "~20 s" },
} as const satisfies Record<string, Bilingual>;

const EXPRESS: readonly TourStep[] = [
  {
    stepId: "X1",
    title: { es: "Voz → cita", en: "Voice → citation" },
    action: { es: "Enviar la nota de voz «la ONU no prende la luz PON»", en: "Send the voice note “la ONU no prende la luz PON” (the ONU's PON light is off)" },
    look: LOOK.voice,
    times: {},
    wait: WAIT.voice,
    waitSec: 45,
    sceneId: "en-sitio-0920",
  },
  {
    stepId: "X2",
    title: { es: "Foto rechazada y repetida", en: "Rejected photo, sent again" },
    action: { es: "Enviar las dos fotos de la etiqueta: con reflejo y buena", en: "Send the two label photos: with glare, then a good one" },
    look: { es: "🔁 y el rechazo por reflejo con un motivo accionable; ✅ en la segunda foto.", en: "🔁 and the glare rejection with an actionable reason; ✅ on the second photo." },
    times: {},
    wait: WAIT.photo,
    waitSec: 40,
    sceneId: "evidencia",
  },
  {
    stepId: "X3",
    title: { es: "Acta", en: "Certificate" },
    action: { es: "Tocar «Cerrar instalación»", en: "Tap “Cerrar instalación” (close installation)" },
    look: LOOK.certificate,
    times: {},
    wait: WAIT.certificate,
    waitSec: 60,
    sceneId: "checklist-completo",
  },
  {
    stepId: "X4",
    title: { es: "Seguridad", en: "Safety" },
    action: { es: "Enviar «cable pelado en el poste»", en: "Send “cable pelado en el poste” (bare cable on the pole)" },
    look: LOOK.hazard,
    times: {},
    wait: WAIT.quick,
    waitSec: 20,
    sceneId: "tercera-visita-1510",
  },
];

const FULL: readonly TourStep[] = [
  {
    stepId: "1",
    title: { es: "Ingresar", en: "Sign in" },
    action: { es: "Abrir tu portada", en: "Open your home page" },
    look: {
      es: "Tu mundo propio con el reloj en pausa el 13/10 a las 07:00, el inicio del día pendiente a las {dayStart} y la orden 24817 fijada como Historia principal.",
      en: "Your own world with the clock paused on Oct 13 at 07:00, the start of the day pending at {dayStart} and work order 24817 pinned as the main story.",
    },
    times: { dayStart },
    wait: { es: "~10 s (el primer ingreso crea tu mundo)", en: "~10 s (the first sign-in creates your world)" },
    waitSec: 10,
    sceneId: null,
  },
  {
    stepId: "2",
    title: { es: "Iniciar el día", en: "Start the day" },
    action: { es: "Iniciar el día", en: "Start the day" },
    look: {
      es: "En el simulador (Rogelio), a las {dayStart}, la plantilla de órdenes del día con el botón «Ver órdenes».",
      en: "In the simulator (Rogelio), at {dayStart}, the orders-of-the-day template with the “Ver órdenes” (view orders) button.",
    },
    times: { dayStart },
    wait: { es: "~5 s", en: "~5 s" },
    waitSec: 5,
    sceneId: "inicio-del-dia",
    lands: { simNow: dayStart.expectedSim, timer: "DAY_START" },
  },
  {
    stepId: "3",
    title: { es: "Ver órdenes", en: "View orders" },
    action: { es: "Tocar «Ver órdenes» como Rogelio", en: "Tap “Ver órdenes” as Rogelio" },
    look: { es: "Las tres órdenes del día con domicilio, plan y ventana.", en: "The day's three work orders with address, plan and time window." },
    times: {},
    wait: WAIT.turn,
    waitSec: 30,
    sceneId: "ordenes-del-dia",
  },
  {
    stepId: "4",
    title: { es: "Nota de voz", en: "Voice note" },
    action: { es: "Ir a la primera visita (09:20) y enviar la nota de voz", en: "Go to the first visit (09:20) and send the voice note" },
    look: LOOK.voice,
    times: {},
    wait: WAIT.voice,
    waitSec: 45,
    sceneId: "en-sitio-0920",
    lands: { simNow: tourSim("09:20") },
  },
  {
    stepId: "5",
    title: { es: "ONU en línea", en: "ONU online" },
    action: { es: "Enviar «Ya limpié el conector, ya prende»", en: "Send “Ya limpié el conector, ya prende” (I cleaned the connector, it's on now)" },
    look: { es: "La ONU en línea a −21,4 dBm y el pedido de tres fotos.", en: "The ONU online at −21.4 dBm and the request for three photos." },
    times: {},
    wait: WAIT.turn,
    waitSec: 30,
    sceneId: "paso-de-diagnostico",
  },
  {
    stepId: "6",
    title: { es: "Pregunta de política", en: "Policy question" },
    action: { es: "Enviar «¿se cobra la roseta en otro cuarto?» y abrir el Manual", en: "Send “¿se cobra la roseta en otro cuarto?” (is moving the rosette to another room charged?) and open the Manual" },
    look: { es: "La respuesta con la cita §COM-04; la sección citada abre en la vista Manual.", en: "The answer citing §COM-04; the cited section opens in the Manual view." },
    times: {},
    wait: WAIT.turn,
    waitSec: 30,
    sceneId: "onu-en-linea",
  },
  {
    stepId: "7",
    title: { es: "Fotos", en: "Photos" },
    action: {
      es: "Enviar las fotos en orden (medidor, etiqueta con reflejo, etiqueta buena, roseta) y tocar «Cliente conforme»",
      en: "Send the photos in order (meter, label with glare, good label, rosette) and tap “Cliente conforme” (customer sign-off)",
    },
    look: {
      es: "Las reacciones ✅ y 🔁, el rechazo por reflejo con su motivo y el checklist completo en el detalle de la orden.",
      en: "The ✅ and 🔁 reactions, the glare rejection with its reason and the complete checklist in the order detail.",
    },
    times: {},
    wait: WAIT.photo,
    waitSec: 100,
    sceneId: "evidencia",
  },
  {
    stepId: "8",
    title: { es: "Acta", en: "Certificate" },
    action: { es: "Tocar «Cerrar instalación» y abrir el buzón de salida", en: "Tap “Cerrar instalación” (close installation) and open the outbox" },
    look: LOOK.certificate,
    times: {},
    wait: WAIT.certificate,
    waitSec: 60,
    sceneId: "checklist-completo",
  },
  {
    stepId: "9",
    title: { es: "Escalamiento", en: "Escalation" },
    action: { es: "Ir a la segunda visita (11:50) y enviar tres notas de voz de potencia baja", en: "Go to the second visit (11:50) and send three low-power voice notes" },
    look: {
      es: "Un caso por intentos de diagnóstico abierto a las 11:50 que vence a las {caseTimeout}; en el simulador (Adriana), la plantilla de caso escalado.",
      en: "A case for diagnosis attempts opened at 11:50 that times out at {caseTimeout}; in the simulator (Adriana), the escalated-case template.",
    },
    times: { caseTimeout },
    wait: { es: "~90 s (tres turnos del agente)", en: "~90 s (three agent turns)" },
    waitSec: 90,
    sceneId: "segunda-visita-1150",
    lands: { simNow: tourSim("11:50") },
  },
  {
    stepId: "10",
    title: { es: "Vencimiento", en: "Timeout" },
    action: { es: "Avanzar al próximo evento y abrir Casos", en: "Advance to the next event and open Cases" },
    look: {
      es: "A las {caseTimeout} nadie tomó el caso: pasa a Héctor con la plantilla de caso reasignado; la escalera se ve en la vista Casos.",
      en: "At {caseTimeout} nobody took the case: it moves to Héctor with the reassigned-case template; the ladder shows in the Cases view.",
    },
    times: { caseTimeout },
    wait: { es: "~5 s", en: "~5 s" },
    waitSec: 5,
    sceneId: "caso-con-supervisora",
    lands: { simNow: caseTimeout.expectedSim, timer: "CASE_TIMEOUT" },
  },
  {
    stepId: "11",
    title: { es: "Tomar y responder", en: "Take and reply" },
    action: { es: "Como Héctor: tomar el caso, mandar la instrucción y cerrar el caso", en: "As Héctor: take the case, send the instruction and close the case" },
    look: {
      es: "El resumen y las fotos llegan a Héctor; su respuesta llega a Rogelio por el puente, la potencia se corrige en el orquestador simulado y el agente retoma.",
      en: "The summary and the photos reach Héctor; his reply reaches Rogelio over the bridge, the power is fixed in the simulated orchestrator and the agent resumes.",
    },
    times: {},
    wait: { es: "~10 s por acción", en: "~10 s per action" },
    waitSec: 30,
    sceneId: "caso-con-respaldo",
  },
  {
    stepId: "12",
    title: { es: "Seguridad", en: "Safety" },
    action: { es: "Ir a la tercera visita (15:10) y enviar «cable pelado en el poste»", en: "Go to the third visit (15:10) and send “cable pelado en el poste” (bare cable on the pole)" },
    look: LOOK.hazard,
    times: {},
    wait: WAIT.quick,
    waitSec: 20,
    sceneId: "tercera-visita-1510",
    lands: { simNow: tourSim("15:10") },
  },
  {
    stepId: "13",
    title: { es: "Métricas", en: "Metrics" },
    action: { es: "Abrir Métricas", en: "Open Metrics" },
    look: {
      es: "La medición del manual y la de fotos con su N y su rótulo; 0 violaciones de política; las decisiones por regla.",
      en: "The manual and photo measurements with their N and label; 0 policy violations; the decisions per rule.",
    },
    times: {},
    wait: { es: "Al instante", en: "Right away" },
    waitSec: 0,
    sceneId: null,
  },
];

export const TOUR_STEPS: Readonly<Record<TourTrackId, readonly TourStep[]>> = { EXPRESS, FULL };

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/** The placeholders a text uses, in order. */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
}

export interface PendingTimer {
  readonly kind: string;
  readonly dueAtSim: string;
}

/**
 * The hour a placeholder shows: the earliest pending timer of its kind (the world's own, as `clock.get`
 * and `tour.steps` return them) or, while none is pending, the hour the step expects.
 */
export function timeOf(time: TourTime, pending: readonly PendingTimer[] = []): string {
  const due = pending.filter((timer) => timer.kind === time.timer).map((timer) => timer.dueAtSim);
  const earliest = due.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return wallTime(earliest ?? time.expectedSim);
}

/** "Qué mirar" in a language, with its hours filled. */
export function lookText(step: TourStep, lang: TourLang, pending: readonly PendingTimer[] = []): string {
  return step.look[lang].replace(PLACEHOLDER, (whole, name: string) => {
    const time = step.times[name];
    return time === undefined ? whole : timeOf(time, pending);
  });
}

/** Every step of both tracks with its track. */
export function allSteps(): Array<{ readonly track: TourTrackId; readonly step: TourStep }> {
  return TOUR_TRACK_IDS.flatMap((track) => TOUR_STEPS[track].map((step) => ({ track, step })));
}
