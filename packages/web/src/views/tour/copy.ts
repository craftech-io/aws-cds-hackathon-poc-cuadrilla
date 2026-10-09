// Texts of the guided-tour panel (docs/design-brief.md §15), es-MX (tuteo) and en. What each step says
// lives in steps.ts; these are the panel's own words around them.
import type { TourLang } from "./steps";

export interface TourPanelCopy {
  readonly htmlLang: string;
  readonly intro: string;
  readonly tracks: string;
  readonly track: (title: string, minutes: number) => string;
  readonly language: string;
  readonly otherLanguage: string;
  readonly step: (id: string) => string;
  readonly look: string;
  readonly wait: string;
  readonly run: string;
  readonly continue: (part: number, total: number) => string;
  readonly running: (part: number, total: number) => string;
  readonly waiting: string;
  readonly done: string;
  readonly stillBusy: string;
  readonly jump: string;
  readonly jumpLabel: (scene: string) => string;
  readonly jumped: (scene: string) => string;
  readonly busy: string;
  readonly scenesOnlyGuest: string;
  readonly failed: string;
}

export const tourCopy: Readonly<Record<TourLang, TourPanelCopy>> = {
  es: {
    htmlLang: "es-MX",
    intro: "Cada paso tiene un botón que hace lo que el paso pide y «Saltar a escena», que carga el mundo justo antes de ese paso. Mientras el mundo está ocupado, los botones esperan.",
    tracks: "Recorrido",
    track: (title, minutes) => `${title} (~${minutes} min)`,
    language: "Idioma del recorrido",
    otherLanguage: "English",
    step: (id) => `Paso ${id}`,
    look: "Qué mirar",
    wait: "Espera esperada",
    run: "Hacer este paso",
    continue: (part, total) => `Seguir con la parte ${part} de ${total}`,
    running: (part, total) => `Haciendo la parte ${part} de ${total}…`,
    waiting: "Esperando que el mundo termine…",
    done: "Listo. Mira lo que dice «Qué mirar».",
    stillBusy: "El mundo sigue ocupado. Cuando termine, sigue con el resto del paso.",
    jump: "Saltar a escena",
    jumpLabel: (scene) => `Saltar a escena: ${scene}`,
    jumped: (scene) => `Escena cargada: ${scene}.`,
    busy: "El mundo está ocupado; los botones vuelven en cuanto termine.",
    scenesOnlyGuest: "«Saltar a escena» está disponible en los mundos de prueba.",
    failed: "No se pudo hacer este paso.",
  },
  en: {
    htmlLang: "en",
    intro: "Every step has a button that does what the step asks and “Jump to scene”, which loads the world just before that step. While the world is busy, the buttons wait.",
    tracks: "Tour",
    track: (title, minutes) => `${title} (~${minutes} min)`,
    language: "Tour language",
    otherLanguage: "Español",
    step: (id) => `Step ${id}`,
    look: "What to look at",
    wait: "Expected wait",
    run: "Do this step",
    continue: (part, total) => `Continue with part ${part} of ${total}`,
    running: (part, total) => `Doing part ${part} of ${total}…`,
    waiting: "Waiting for the world to finish…",
    done: "Done. See “What to look at”.",
    stillBusy: "The world is still busy. When it finishes, continue with the rest of the step.",
    jump: "Jump to scene",
    jumpLabel: (scene) => `Jump to scene: ${scene}`,
    jumped: (scene) => `Scene loaded: ${scene}.`,
    busy: "The world is busy; the buttons come back as soon as it finishes.",
    scenesOnlyGuest: "“Jump to scene” is available in trial worlds.",
    failed: "This step could not be done.",
  },
};
