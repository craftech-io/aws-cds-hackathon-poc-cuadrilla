// Texts of the manual viewer (`/app/manual`, docs/design-brief.md §6; FL-028, FL-090). Spanish of Mexico.
// The operator's visible name and the synthetic-demo disclaimer come from `manual.sections` (ADR-0018).

export const manualCopy = {
  operator: (name: string) => `Manual de procedimientos de ${name}`,
  version: (label: string) => `Versión vigente: ${label}`,
  readOnly: "Solo lectura: el copiloto responde con este manual y cita la sección de cada respuesta.",
  sections: "Secciones",
  categories: {
    GEN: "Generales",
    INS: "Instalación",
    DIAG: "Diagnóstico",
    EVI: "Evidencia",
    CAL: "Calidad",
    COM: "Políticas comerciales",
    ESC: "Escalamiento",
    SEG: "Seguridad",
  } as Readonly<Record<string, string>>,
  otherCategory: "Otras",
  choose: "Elige una sección para leerla.",
  notFound: "Esa sección no está en el manual vigente.",
  sectionLabel: (id: string, title: string) => `§${id} · ${title}`,
} as const;
