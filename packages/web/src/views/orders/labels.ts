// What the field-work views (orders, the detail of an order, cases, evidence review) call each code the
// BFF answers with, in the console's Spanish of Mexico. One source for the four views: a code never
// reaches the screen (docs/test-plan.md §3, "sin códigos crudos"); an unknown one reads as its fallback.
// Installer-facing texts live in packages/bff/src/copy/es-MX.ts; these are the supervisor's words.
import type {
  AuditDecision,
  CaseKind,
  CaseReason,
  CaseStatus,
  ChecklistItem,
  ChecklistItemStatus,
  HazardCategory,
  MessageKind,
  OnuOperState,
  RejectReason,
  Rung,
  RungOutcome,
  StepOutcome,
  Symptom,
  TimerKind,
  TurnTrigger,
  Verdict,
  WorkOrderStatus,
} from "@cuadrilla/shared";
import type { BadgeTone } from "../../components/Badge";

export const workOrderStatusLabel: Readonly<Record<WorkOrderStatus, string>> = {
  SCHEDULED: "Programada",
  IN_PROGRESS: "En curso",
  CLOSED: "Cerrada",
  FAILED_VISIT: "Visita fallida",
  RESCHEDULED: "Reprogramada",
  CANCELLED: "Cancelada",
  REASSIGNED: "Reasignada",
};

export const workOrderStatusTone: Readonly<Record<WorkOrderStatus, BadgeTone>> = {
  SCHEDULED: "neutral",
  IN_PROGRESS: "info",
  CLOSED: "success",
  FAILED_VISIT: "danger",
  RESCHEDULED: "warning",
  CANCELLED: "neutral",
  REASSIGNED: "warning",
};

/** In the order the checklist is closed (docs/design-brief.md §4). */
export const CHECKLIST_ORDER: readonly ChecklistItem[] = ["ONU_ONLINE", "POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO", "CUSTOMER_OK"];

export const checklistItemLabel: Readonly<Record<ChecklistItem, string>> = {
  ONU_ONLINE: "ONU en línea",
  POWER_READING_PHOTO: "Foto del medidor",
  ONU_LABEL_PHOTO: "Foto de la etiqueta",
  ROSETTE_PHOTO: "Foto de la roseta",
  CUSTOMER_OK: "Conformidad del cliente",
};

export const checklistStatusLabel: Readonly<Record<ChecklistItemStatus, string>> = {
  PENDING: "Pendiente",
  IN_REVIEW: "En revisión",
  PASSED: "Validado",
  REJECTED: "Rechazado",
  OVERRIDDEN: "Validado manualmente",
};

export const checklistStatusTone: Readonly<Record<ChecklistItemStatus, BadgeTone>> = {
  PENDING: "neutral",
  IN_REVIEW: "warning",
  PASSED: "success",
  REJECTED: "danger",
  OVERRIDDEN: "brand",
};

export const onuStateLabel: Readonly<Record<OnuOperState, string>> = {
  ONLINE: "En línea",
  OFFLINE: "Fuera de línea",
  LOS: "Sin señal óptica",
  DYING_GASP: "Sin energía",
  NOT_PROVISIONED: "No aprovisionada",
};

export const verdictLabel: Readonly<Record<Verdict, string>> = { PASS: "Validada", REJECT: "Rechazada", UNSURE: "Dudosa" };

export const verdictTone: Readonly<Record<Verdict, BadgeTone>> = { PASS: "success", REJECT: "danger", UNSURE: "warning" };

export const rejectReasonLabel: Readonly<Record<RejectReason, string>> = {
  BLURRY: "Borrosa",
  GLARE: "Reflejo sobre la etiqueta o la pantalla",
  CROPPED: "Recortada",
  DARK: "Muy oscura",
  WRONG_SUBJECT: "No muestra lo que se pidió",
  OUT_OF_RANGE_LOW: "Potencia por debajo del rango",
  OUT_OF_RANGE_HIGH: "Potencia por encima del rango",
  WRONG_WAVELENGTH: "El medidor no está en 1490 nm",
  SERIAL_MISMATCH: "El serial no es el de la orden",
  READING_MISMATCH: "La lectura no coincide con la red",
  DUPLICATE_EVIDENCE: "Foto ya usada en otra orden",
  UNREADABLE: "No se puede leer",
};

export const symptomLabel: Readonly<Record<Symptom, string>> = {
  NO_PON_LIGHT: "Luz PON apagada",
  LOW_POWER: "Potencia fuera de rango",
  NO_POWER: "ONU sin energía",
  NOT_PROVISIONED: "ONU no aprovisionada",
  NO_BROWSING: "En línea sin navegación",
  OTHER: "Otra falla",
};

export const stepOutcomeLabel: Readonly<Record<StepOutcome, string>> = { PENDING: "Sin resultado todavía", FIXED: "Resuelto", NO_CHANGE: "Sin cambio", WORSE: "Empeoró" };

export const caseKindLabel: Readonly<Record<CaseKind, string>> = { ESCALATION: "Escalamiento", SAFETY: "Seguridad" };

export const caseReasonLabel: Readonly<Record<CaseReason, string>> = {
  OUT_OF_MANUAL: "Fuera del manual",
  DIAGNOSIS_ATTEMPTS: "Tres pasos de diagnóstico sin resolver",
  PHOTO_ATTEMPTS: "Foto rechazada tres veces",
  INSTALLER_ASKED: "El instalador pidió a su supervisor",
  NOT_PROVISIONED: "ONU no aprovisionada",
  DENIED_TOPIC: "Tema que el asistente no responde",
  PROMPT_INJECTION: "Mensaje con instrucciones sospechosas",
  SAFETY: "Riesgo de seguridad",
  CERTIFICATE_UNDELIVERED: "El acta no llegó al cliente",
  OTHER: "Otro motivo",
};

export const caseStatusLabel: Readonly<Record<CaseStatus, string>> = { OPEN: "Abierto", TAKEN: "Tomado", CLOSED: "Cerrado" };

export const caseStatusTone: Readonly<Record<CaseStatus, BadgeTone>> = { OPEN: "warning", TAKEN: "info", CLOSED: "success" };

export const rungLabel: Readonly<Record<Rung, string>> = { PRIMARY: "Supervisión de turno", SECONDARY: "Supervisión de respaldo", ZONE_CHIEF: "Jefatura de zona" };

export const rungOutcomeLabel: Readonly<Record<RungOutcome, string>> = {
  NOTIFIED: "Notificado",
  SKIPPED: "Saltado",
  TIMED_OUT: "Venció sin respuesta",
  DECLINED: "Respondió que no puede",
  TAKEN: "Tomó el caso",
};

export const rungOutcomeTone: Readonly<Record<RungOutcome, BadgeTone>> = { NOTIFIED: "info", SKIPPED: "neutral", TIMED_OUT: "warning", DECLINED: "warning", TAKEN: "success" };

/** Why a rung was skipped or moved on (packages/bff/src/domain/cases.ts, `RungSkipReason`, and the ladder's own). */
export const rungReasonLabel: Readonly<Record<string, string>> = {
  NO_CHANNEL: "sin canal para avisarle",
  OPTED_OUT: "pidió no recibir mensajes",
  OFF_ROSTER: "no está en el turno",
  NO_PERSON: "no hay nadie asignado",
  MANUAL: "vencimiento forzado desde el reloj de demo",
  TIMEOUT: "pasó el tiempo de espera",
};

export const rungChannelLabel: Readonly<Record<string, string>> = { TEMPLATE: "plantilla de WhatsApp", INTERACTIVE: "mensaje con botones", EMAIL: "email", CONSOLE: "consola" };

export const hazardLabel: Readonly<Record<HazardCategory, string>> = {
  ELECTRICAL: "Eléctrico",
  POLE: "Poste",
  HEIGHT: "Altura",
  WEATHER: "Clima",
  ANIMAL: "Animal",
  THREAT: "Amenaza",
  OTHER: "Otro",
};

export const messageKindLabel: Readonly<Record<MessageKind, string>> = {
  DAY_START: "Inicio del día",
  ORDERS_DETAIL: "Órdenes del día",
  REPLY: "Respuesta del asistente",
  SYSTEM_NOTICE: "Aviso del sistema",
  ORDER_CHOICE: "Elección de orden",
  SAFETY_INSTRUCTION: "Instrucción de seguridad",
  CASE_NOTICE: "Aviso del caso",
  CASE_REQUEST: "Pedido de caso al supervisor",
  SAFETY_ALERT: "Alerta de seguridad",
  CASE_BRIEF: "Resumen del caso",
  CASE_TAKEN_NOTICE: "Caso tomado",
  RELAY: "Puente con el supervisor",
  SUPERVISOR_REPLY_TEMPLATE: "Respuesta del supervisor",
  CERTIFICATE: "Acta de instalación",
  CERTIFICATE_EMAIL: "Email del acta",
  ZONE_CHIEF_ALERT: "Aviso a la jefatura de zona",
  READ_ACK: "Acuse de lectura",
  VERDICT_REACTION: "Reacción a la foto",
};

export const triggerLabel: Readonly<Record<TurnTrigger, string>> = {
  INSTALLER_MESSAGE: "mensaje del instalador",
  ORDERS_REQUESTED: "pidió sus órdenes",
  CASE_CLOSED: "caso cerrado por el supervisor",
  WORK_ORDER_CHANGED: "cambio del despacho",
  EVIDENCE_OVERRIDDEN: "validación manual de evidencia",
};

export const timerKindLabel: Readonly<Record<TimerKind | "DEFERRED_SEND", string>> = {
  DAY_START: "Inicio del día",
  CASE_TIMEOUT: "Vencimiento del caso",
  DEFERRED_SEND: "Envío diferido",
  CERT_RETRY: "Reintento del acta",
};

export const auditDecisionLabel: Readonly<Record<AuditDecision, string>> = {
  ALLOW: "Permitido",
  DENY: "Denegado",
  DEFER: "Diferido",
  ACTION: "Acción",
  VIOLATION: "Fuera de política",
};

export const auditDecisionTone: Readonly<Record<AuditDecision, BadgeTone>> = { ALLOW: "success", DENY: "danger", DEFER: "warning", ACTION: "info", VIOLATION: "danger" };

/** The audited actions an order's timeline shows most; anything else reads as the decision itself. */
export const auditActionLabel: Readonly<Record<string, string>> = {
  SEND_WHATSAPP: "Envío por WhatsApp",
  SEND_EMAIL: "Envío de email",
  EVIDENCE_OVERRIDDEN: "Validación manual de evidencia",
  TAKE_CASE: "Tomar caso",
  CLOSE_CASE: "Cerrar caso",
  DECLINE_CASE: "No puedo tomar el caso",
  CASE_OPENED: "Caso abierto",
  CASE_CLOSED: "Caso cerrado",
  CASE_DECLINED: "Caso rechazado",
  RELAY: "Mensaje por el puente",
  SAFETY_DETECTED: "Riesgo de seguridad detectado",
  GUARDRAIL_INTERVENED: "Intervino una barrera de contenido",
  GUARDRAIL_BLOCK: "Bloqueado por una barrera de contenido",
  BLOCKED: "Bloqueado",
  TOOL_DENIED: "Herramienta denegada",
  POLICY_VIOLATION: "Fuera de política",
  WINDOW_FALLBACK: "Fuera de la ventana de 24 h: se usó una plantilla",
  TRANSCRIBED: "Nota de voz transcrita",
  TRANSCRIBE_FAILED: "No se pudo transcribir la nota de voz",
  LOW_CONFIDENCE: "Validación con poca confianza",
  STEP_RECORDED: "Paso de diagnóstico registrado",
  CUSTOMER_OK: "Cliente conforme",
  CLOSE_INSTALLATION: "Cerrar instalación",
  VIEW_ORDERS: "Ver órdenes",
  CROSS_ISP: "Acceso a datos de otra operadora",
  DISPATCH_EVENT: "Evento del despacho",
  DAY_START: "Inicio del día",
};

export const emailStatusLabel: Readonly<Record<string, string>> = {
  QUEUED: "En cola",
  SENT: "Enviado",
  DELIVERED: "Entregado",
  READ: "Leído",
  DELAYED: "Demorado",
  BOUNCED: "Rebotado",
  COMPLAINED: "Marcado como no deseado",
  FAILED: "Falló",
  DENIED: "Retenido por la política",
  RECEIVED: "Recibido",
  DEFERRED: "Diferido",
};

export const templateLabel: Readonly<Record<string, string>> = {
  ordenes_del_dia: "Plantilla «órdenes del día»",
  caso_escalado: "Plantilla «caso escalado»",
  caso_reasignado: "Plantilla «caso reasignado»",
  alerta_seguridad: "Plantilla «alerta de seguridad»",
  respuesta_supervisor: "Plantilla «respuesta del supervisor»",
  acta_instalacion: "Plantilla «acta de instalación»",
};

export const deliveryTargetLabel: Readonly<Record<string, string>> = { CUSTOMER: "Cliente", OPS_MAILBOX: "Buzón de operaciones", INSTALLER: "Instalador", ZONE_CHIEF: "Jefatura de zona" };

/** A label of a code the map may not know yet (a newer BFF): never the raw code. */
export function labelOf(map: Readonly<Record<string, string>>, code: string | null | undefined, fallback: string): string {
  return code === null || code === undefined ? fallback : (map[code] ?? fallback);
}
