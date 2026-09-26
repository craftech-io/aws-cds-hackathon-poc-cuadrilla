// Every string the operator's console shows. Spanish of Mexico (tuteo): the console is for the
// operator's supervisors and operations staff; installer-facing texts and templates live in
// packages/bff/src/copy/es-MX.ts (docs/design-brief.md §10). From wave 5 on, each view keeps its own
// texts in views/<view>/copy.ts; this file keeps the shell and the shared keys. No text here names
// the operator: its visible name comes from the brand configuration at runtime (ADR-0018).
import type { Weekday } from "@cuadrilla/shared";
import type { AdvanceStep, PendingKind } from "../lib/world-clock";

export const PRODUCT_NAME = "Cuadrilla";

export const copy = {
  app: {
    tagline: "Consola de la operadora",
    loading: "Cargando la consola…",
    signOut: "Cerrar sesión",
    roleLabel: "Rol",
    ispLabel: "Operadora",
    skipToContent: "Ir al contenido",
    syntheticData: "Demo sintética: datos 100 % inventados",
    menu: "Menú de la consola",
  },
  clock: {
    label: "Hora simulada",
    paused: "reloj de demo en pausa",
    running: "reloj en vivo",
    loading: "Cargando la hora simulada…",
    unavailable: "La hora simulada no está disponible por ahora; la consola lo vuelve a intentar sola.",
    controls: "Controles del reloj de demo",
    advanceToNext: "Avanzar al próximo evento",
    advance: { 10: "+10 min", 60: "+1 h" } satisfies Record<AdvanceStep, string>,
    busy: {
      TURN: "El agente está escribiendo… (~30 s)",
      TRANSCRIBE: "Transcribiendo nota de voz (~15 s)",
      VALIDATION: "Validando foto (~10 s)",
      EVENT: "Procesando un evento en cola (~5 s)",
      MAIL: "Esperando el primer evento del email (~20 s)",
    } satisfies Record<PendingKind, string>,
    busyFallback: "El mundo está ocupado; los controles vuelven en cuanto termine.",
    morePending: (count: number) => (count === 1 ? "y 1 cosa más en curso" : `y ${count} cosas más en curso`),
    forceHint: "Lleva más de 5 minutos ocupado: puedes avanzar igual desde el reloj de demo.",
    openClock: "Abrir el reloj de demo",
    weekdays: { MON: "lun", TUE: "mar", WED: "mié", THU: "jue", FRI: "vie", SAT: "sáb", SUN: "dom" } satisfies Record<Weekday, string>,
  },
  tour: {
    open: "Recorrido guiado",
    title: "Recorrido guiado",
    close: "Cerrar",
    placeholderTitle: "El recorrido guiado llega pronto",
    placeholderLead: "Aquí vas a ver los pasos del recorrido exprés (~5 min) y del completo (~15 min), con su botón y lo que conviene mirar en cada uno.",
  },
  roles: {
    SUPERVISOR: "Supervisor",
    OPS: "Operaciones",
    GUEST: "Invitado",
  },
  login: {
    unconfiguredTitle: "Consola sin configurar",
    unconfiguredLead: "Faltan variables de build del stage (infra/auth.ts). Sin ellas no hay inicio de sesión.",
    noAccessTitle: "Tu usuario no tiene una operadora asignada",
    noAccessLead: "Iniciaste sesión correctamente, pero tu usuario todavía no pertenece a ninguna operadora. Pide a tu supervisor que te invite.",
  },
  errors: {
    notFoundTitle: "Esta página no existe",
    notFoundLead: "Revisa el enlace o vuelve al inicio.",
    forbiddenTitle: "Tu rol no tiene acceso a esta vista",
    forbiddenLead: "Si crees que deberías verla, pide a tu supervisor que ajuste tu rol.",
    backHome: "Volver al inicio",
  },
  nav: {
    groups: {
      work: "Trabajo de campo",
      team: "Equipo",
      demo: "Demo",
      control: "Control",
    },
  },
  views: {
    "guest-home": {
      title: "Tu mundo de prueba",
      description: "El estado de tu mundo de prueba, lo que ya puedes usar de la consola y tu cuenta.",
    },
    orders: {
      title: "Órdenes del día",
      description: "Cada orden de trabajo con su instalador, ventana, checklist, estado de la ONU y casos abiertos.",
    },
    "order-detail": {
      title: "Detalle de la orden",
      description: "La línea de tiempo de la orden: mensajes, transcripciones, fotos con su veredicto, pasos, citas del manual, decisiones, casos y acta.",
    },
    cases: {
      title: "Casos",
      description: "Lo que el agente escaló, con la escalera de supervisores y el puente de mensajes.",
    },
    evidence: {
      title: "Revisión de evidencia",
      description: "Fotos dudosas o rechazadas, con la rúbrica y la salida del validador.",
    },
    people: {
      title: "Personal",
      description: "Instaladores, supervisores y jefes de zona con su lista de permitidos, opt-in y roster por turno.",
    },
    manual: {
      title: "Manual",
      description: "Secciones del manual de procedimientos vigente (demo sintética), con su id.",
    },
    simulator: {
      title: "Simulador de teléfono",
      description: "WhatsApp simulado: el instalador y los supervisores de este mundo.",
    },
    clock: {
      title: "Reloj de demo",
      description: "Hora simulada del mundo, próximos eventos y controles de la demo.",
    },
    outbox: {
      title: "Buzón de salida",
      description: "Cada email enviado (actas y alertas), con su adjunto y los eventos de entrega.",
    },
    metrics: {
      title: "Métricas",
      description: "Resolución sin escalar, latencias, validación de fotos, costo por conversación y techo del día.",
    },
    audit: {
      title: "Bitácora",
      description: "Cada decisión con la regla aplicada, el evento que la disparó y quién la tomó.",
    },
  },
  placeholder: {
    title: "Vista en construcción",
    lead: "Esta vista llega en una próxima entrega del plan de construcción.",
  },
  public: {
    join: {
      title: "Alta de personal",
      lead: "Aquí va a estar el código QR para darte de alta: envías ALTA por WhatsApp al número de la demo. Llega en una próxima entrega.",
    },
  },
} as const;
