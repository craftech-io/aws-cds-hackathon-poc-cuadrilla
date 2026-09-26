// Manual v1, sections COM, ESC and CAL (docs/seed-spec.md §8): the commercial policies of the demo,
// invented for it and labelled so (the operator bills monthly and extra meters go on the next invoice;
// the installer never charges on site), when and how to escalate, and the customer's conformity.
import type { ManualSection } from "./types";

const INVENTED = "Política comercial inventada para esta demo.";

export const COMMERCIAL_SECTIONS: readonly ManualSection[] = [
  {
    id: "COM-01",
    title: "Instalación estándar",
    body: [
      INVENTED,
      "",
      "La instalación estándar incluye, sin costo adicional para el cliente:",
      "",
      "- Hasta 30 m de drop exterior, desde la caja terminal hasta el punto de entrada al domicilio.",
      "- Hasta 15 m de cable interior, desde el punto de entrada hasta la roseta.",
      "- Una roseta óptica.",
      "- La ONU en comodato con su eliminador (§COM-06).",
      "",
      "Lo que pase de esos metros se registra como cargo adicional (§COM-02).",
    ].join("\n"),
  },
  {
    id: "COM-02",
    title: "Cargos adicionales",
    body: [
      "Modelo comercial inventado para la demo: la operadora factura por mes.",
      "",
      "- Los metros de drop exterior o de cable interior que excedan lo incluido (§COM-01) se registran en la orden como cargo adicional y aparecen en la siguiente factura del cliente.",
      "- Registra la cantidad exacta de metros extra; el monto lo calcula la operadora.",
      "- El instalador nunca cobra en sitio: no recibe efectivo, transferencias ni pagos de ningún tipo, ni da precios de los cargos.",
      "- Si el cliente no está de acuerdo con el cargo, no se instala el tramo extra y se consulta al supervisor.",
    ].join("\n"),
  },
  {
    id: "COM-03",
    title: "Planes y precios",
    body: [
      INVENTED,
      "",
      "El instalador no cambia el plan del cliente ni informa precios, promociones, descuentos o condiciones del contrato. Tampoco ofrece bonificaciones ni meses sin costo.",
      "",
      "Si el cliente pregunta por otro plan, un precio o una promoción, indícale que lo consulte en el canal comercial de la operadora: la app de autogestión o una sucursal. Instala el plan que dice la orden.",
    ].join("\n"),
  },
  {
    id: "COM-04",
    title: "Reubicación de la roseta",
    body: [
      INVENTED,
      "",
      "Si el cliente quiere la roseta en otro lugar dentro del domicilio (por ejemplo, en otro cuarto):",
      "",
      "- Hasta 15 m de cable interior desde el punto de entrada, la reubicación no tiene costo.",
      "- Si se necesitan más de 15 m, el tramo extra lleva un cargo de extensión en la siguiente factura (§COM-02).",
      "- La nueva ubicación tiene que cumplir §INS-04: altura, cercanía a un contacto y fijación al muro.",
    ].join("\n"),
  },
  {
    id: "COM-05",
    title: "Cliente ausente",
    body: [
      "- Si nadie abre al llegar, espera 15 minutos contados desde el inicio de la ventana de cita (o desde tu llegada, si llegaste después).",
      "- Durante la espera toca de nuevo y avisa por el asistente de campo que el cliente no está.",
      "- Si pasados los 15 minutos nadie atiende, se registra la visita fallida: la orden no se instala, no genera acta y la reprograma la operadora.",
      "- No dejes equipos ni cables instalados sin la presencia del cliente.",
    ].join("\n"),
  },
  {
    id: "COM-06",
    title: "Equipos que se entregan",
    body: [
      INVENTED,
      "",
      "Al cliente se le entrega únicamente la ONU en comodato y su eliminador. La ONU sigue siendo de la operadora.",
      "",
      "No se entregan ni se instalan otros equipos: repetidores, routers, extensores, cables de red extra o equipos del propio instalador. Cualquier equipo adicional lo contrata el cliente por el canal comercial (§COM-03).",
    ].join("\n"),
  },
  {
    id: "ESC-01",
    title: "Cuándo escalar",
    body: [
      "Se escala al supervisor de turno cuando:",
      "",
      "- Tres pasos de diagnóstico del mismo síntoma no cambian nada.",
      "- La foto de un mismo ítem se rechaza tres veces.",
      "- La ONU no está aprovisionada (§DIAG-04).",
      "- Surge una pregunta o una situación que este manual no cubre: no se improvisa.",
      "- Hay cualquier riesgo para ti o para otras personas (§SEG-01 a §SEG-05).",
      "",
      "Si el supervisor de turno no responde a tiempo, el caso pasa al supervisor de respaldo y después a la jefatura de zona.",
    ].join("\n"),
  },
  {
    id: "ESC-02",
    title: "Qué se le pasa al supervisor",
    body: [
      "Al escalar, el supervisor recibe:",
      "",
      "- El número de la orden.",
      "- El síntoma o el motivo del caso.",
      "- Los pasos que ya hiciste y su resultado.",
      "- Las lecturas de potencia y el estado de la ONU.",
      "- Las fotos de la orden.",
      "",
      "El asistente de campo arma y envía este resumen al abrir el caso; no hace falta repetirlo. Mientras el supervisor atiende el caso, lo que escribas sobre esa orden le llega directamente a él.",
    ].join("\n"),
  },
  {
    id: "CAL-01",
    title: "Conformidad del cliente",
    body: [
      "La conformidad del cliente es su confirmación de que el servicio quedó funcionando: navega desde su propio equipo y está de acuerdo con la instalación.",
      "",
      "- Pídele que pruebe la conexión antes de retirarte.",
      "- Cuando la dé, regístrala con el botón \"Cliente conforme\" del asistente de campo.",
      "- Si el cliente no da su conformidad, registra el motivo que te dé y se escala a tu supervisor. No cierres la orden sin conformidad.",
    ].join("\n"),
  },
];
