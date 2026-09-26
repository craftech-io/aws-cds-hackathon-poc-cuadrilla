// Every string the operator's console shows. Spanish of Mexico (tuteo): the console is for the
// operator's supervisors and operations staff; installer-facing texts and templates live in
// packages/bff/src/copy/es-MX.ts (docs/design-brief.md §10). From wave 5 on, each view keeps its own
// texts in views/<view>/copy.ts; this file keeps the shell and the shared keys. No text here names
// the operator: its visible name comes from the brand configuration at runtime (ADR-0018).

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
  },
  roles: {
    SUPERVISOR: "Supervisor",
    OPS: "Operaciones",
    JUDGE: "Jurado",
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
    orders: {
      title: "Órdenes del día",
      description: "Cada orden de trabajo con su instalador, ventana, checklist, estado de la ONU y casos abiertos.",
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
} as const;
