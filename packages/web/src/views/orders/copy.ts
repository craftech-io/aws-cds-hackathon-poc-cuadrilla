// Texts of the day's work orders (`/app/orders`). Spanish of Mexico; nothing here names the operator.
import type { CaseFilter, StatusFilter } from "./orders-model";

export const ordersCopy = {
  title: "Órdenes del día",
  description: "Cada orden de trabajo con su instalador, ventana, checklist, estado de la ONU y casos abiertos.",
  caption: "Órdenes de trabajo del día",
  scope: {
    label: "Alcance",
    crews: "Equipo de campo",
    allCrews: "Todos los equipos",
    crewFallback: (index: number) => `Equipo ${index}`,
    day: "Día",
    today: "hoy",
  },
  filters: {
    statusLabel: "Estado",
    casesLabel: "Casos",
    status: { ALL: "Todas", OPEN: "Por hacer o en curso", CLOSED: "Cerradas", ISSUES: "Con incidencias" } satisfies Record<StatusFilter, string>,
    cases: { ALL: "Todas", WITH_CASES: "Con casos abiertos" } satisfies Record<CaseFilter, string>,
  },
  columns: {
    order: "Orden",
    installer: "Instalador",
    customer: "Cliente (ficticio)",
    window: "Ventana",
    status: "Estado",
    checklist: "Checklist",
    onu: "ONU",
    cases: "Casos",
  },
  mainStory: "Historia principal",
  onHoldSafety: "En espera por seguridad",
  onuUnknown: "Sin lectura todavía",
  onuOutOfRange: "fuera de rango",
  noCases: "Ninguno",
  openCases: (count: number) => (count === 1 ? "1 abierto" : `${count} abiertos`),
  checklistProgress: (done: number, total: number) => `${done} de ${total}`,
  checklistLegend: "Validado ✓ · Rechazado ✗ · En revisión ? · Pendiente –",
  emptyTitle: "No hay órdenes para este día",
  emptyLead: "Cambia el equipo, el día o los filtros para ver otras órdenes.",
  openOrder: (number: string) => `Abrir la orden ${number}`,
} as const;
