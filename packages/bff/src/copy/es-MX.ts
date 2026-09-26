// Every fixed text Cuadrilla sends to the staff on WhatsApp, in Mexican Spanish with "tú"
// (ADR-0013). One source: the worker, the channel handlers, the ladder, the validator, the seed (the
// manual's §SEG-01 and the rubric) and the tests import from here. Nothing here names the operator:
// the visible name is runtime configuration resolved by `resolveBrand` (brand.ts, ADR-0018), and
// the partner's name only ever arrives as a parameter.
import type { ChecklistItem, PhotoItem, RejectReason } from "@cuadrilla/shared";
import { inChecklistOrder, listInSpanish } from "./helpers";
import type { CaseBriefInput, CaseChoiceInput, CaseReasonInput, CopyPack, OrderChoiceInput, StaffRole } from "./types";

/** Version of the opt-in poster text, recorded with every consent (`record_consent`). */
export const OPT_IN_TEXT_VERSION = "v001";

/** What each photo item shows, as the rejection texts name it. */
const PHOTO_SUBJECT: Readonly<Record<PhotoItem, string>> = {
  POWER_READING_PHOTO: "la pantalla del medidor",
  ONU_LABEL_PHOTO: "la etiqueta de la ONU",
  ROSETTE_PHOTO: "la roseta",
};

/** What cannot be read when a photo of that item fails. */
const NOT_READABLE: Readonly<Record<PhotoItem, string>> = {
  POWER_READING_PHOTO: "no se lee el valor",
  ONU_LABEL_PHOTO: "no se lee el serial",
  ROSETTE_PHOTO: "no se ve bien",
};

/** Short name of each photo item inside a case category ("foto de la etiqueta rechazada 3 veces"). */
const PHOTO_SHORT: Readonly<Record<PhotoItem, string>> = {
  POWER_READING_PHOTO: "foto del medidor",
  ONU_LABEL_PHOTO: "foto de la etiqueta",
  ROSETTE_PHOTO: "foto de la roseta",
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function rejectReason(reason: RejectReason, item: PhotoItem): string {
  const subject = PHOTO_SUBJECT[item];
  const notReadable = NOT_READABLE[item];
  switch (reason) {
    case "BLURRY":
      return `La foto salió borrosa y ${notReadable}: apoya bien el teléfono, toca la pantalla para enfocar y tómala de nuevo.`;
    case "GLARE":
      return `Hay reflejo sobre ${subject} y ${notReadable}: inclina un poco el teléfono y apaga el flash.`;
    case "CROPPED":
      return `${capitalize(subject)} quedó cortada en la foto: aléjate un poco para que salga completa y tómala de nuevo.`;
    case "DARK":
      return `La foto salió muy oscura y ${notReadable}: busca más luz, por ejemplo cerca de una ventana, y tómala de nuevo.`;
    case "WRONG_SUBJECT":
      return `Esa foto no muestra ${subject}. Mándame una foto donde se vea completa.`;
    case "OUT_OF_RANGE_LOW":
      return "La lectura está por debajo del rango aceptado para esta zona y así no se puede cerrar: limpia los conectores de los dos extremos, revisa empalmes y curvas del cable y vuelve a medir.";
    case "OUT_OF_RANGE_HIGH":
      return "La lectura está por encima del rango aceptado (sobrecarga) y así no se puede cerrar: revisa la medición y, si sigue igual, consulta a tu supervisor.";
    case "WRONG_WAVELENGTH":
      return "El medidor no está en 1490 nm: cámbialo a 1490 nm, vuelve a medir y manda la foto de nuevo.";
    case "SERIAL_MISMATCH":
      return "La etiqueta no es de la ONU de esta orden: revisa que instalaste el equipo correcto y manda la foto de su etiqueta.";
    case "READING_MISMATCH":
      return "El valor de la foto no coincide con lo que reporta la red para esta ONU: vuelve a medir en la roseta de esta orden y manda la foto nueva.";
    case "DUPLICATE_EVIDENCE":
      return "Esa foto ya se usó como evidencia en otra orden: toma una foto nueva aquí mismo.";
    case "UNREADABLE":
      return `En la foto ${notReadable}: quita lo que tape ${subject} y tómala de frente, bien enfocada.`;
  }
}

const CHECKLIST_ITEM: Readonly<Record<ChecklistItem, string>> = {
  ONU_ONLINE: "la ONU en línea con la potencia en rango",
  POWER_READING_PHOTO: "la foto de la lectura del medidor",
  ONU_LABEL_PHOTO: "la foto de la etiqueta de la ONU",
  ROSETTE_PHOTO: "la foto de la roseta instalada",
  CUSTOMER_OK: "la conformidad del cliente",
};

const SYMPTOM: CopyPack["symptom"] = {
  NO_PON_LIGHT: "luz PON apagada",
  LOW_POWER: "potencia fuera de rango",
  NO_POWER: "ONU sin energía",
  NOT_PROVISIONED: "ONU no aprovisionada",
  NO_BROWSING: "ONU en línea sin navegación",
  OTHER: "falla sin resolver",
};

function caseReason({ reason, symptom, item, sensitive }: CaseReasonInput): string {
  switch (reason) {
    case "OUT_OF_MANUAL":
      return "pregunta que el manual no cubre";
    case "DIAGNOSIS_ATTEMPTS":
      return `${SYMPTOM[symptom ?? "OTHER"]} después de 3 pasos`;
    case "PHOTO_ATTEMPTS":
      return `${item === undefined ? "foto" : PHOTO_SHORT[item]} rechazada 3 veces`;
    case "INSTALLER_ASKED":
      return "pidió hablar con su supervisor";
    case "NOT_PROVISIONED":
      return "ONU no aprovisionada en el sistema";
    case "DENIED_TOPIC":
      return "consulta de un tema que Cuadrilla no responde";
    case "PROMPT_INJECTION":
      return "mensaje con instrucciones sospechosas";
    case "SAFETY":
      return "riesgo de seguridad en el sitio";
    case "CERTIFICATE_UNDELIVERED":
      return "el acta no llegó al cliente";
    case "OTHER":
      return sensitive === "CARD" ? "datos de tarjeta" : "otro motivo";
  }
}

function welcome(firstName: string, role: StaffRole): string {
  if (role === "SUPERVISOR") {
    return `¡Listo, ${firstName}! Ya tienes activo Cuadrilla. Aquí te van a llegar los casos de tu equipo con los botones Tomar caso y No puedo. Al empezar tu turno envía TURNO; para dejar de recibir mensajes, envía BAJA.`;
  }
  return `¡Listo, ${firstName}! Ya tienes activo Cuadrilla, el asistente de campo de la operadora en WhatsApp. Escríbeme o mándame notas de voz con tus dudas de la orden, y fotos de la evidencia cuando te las pida. Para dejar de recibir mensajes, envía BAJA.`;
}

function closeNotComplete(missing: readonly ChecklistItem[]): string {
  const items = inChecklistOrder(missing).map((item) => CHECKLIST_ITEM[item]);
  if (items.length === 0) return "Todavía no puedo cerrar la instalación: la orden está en espera hasta que tu supervisor cierre su caso.";
  return `Todavía no puedo cerrar la instalación. ${items.length === 1 ? "Falta" : "Faltan"}: ${listInSpanish(items)}.`;
}

function caseBrief({ caseLabel, workOrderNumber, installerFirstName, reasonText, summary }: CaseBriefInput): string {
  return [
    `Caso ${caseLabel} · orden ${workOrderNumber}`,
    `Instalador: ${installerFirstName}`,
    `Motivo: ${reasonText}`,
    `Resumen: ${summary}`,
    `Lo que escribas aquí le llega a ${installerFirstName}. Toca Cerrar caso cuando termines.`,
  ].join("\n");
}

export const esMX: CopyPack = {
  brandLine: (partnerName) => (partnerName === undefined ? "Cuadrilla · Powered by Craftech" : `Cuadrilla for ${partnerName} · Powered by Craftech`),
  syntheticDemoNotice: (partnerName) => `Demo sintética: el manual, las políticas y los datos son inventados y no son las políticas reales de ${partnerName}.`,
  fictitiousOperatorNotice: "Demo con datos 100 % sintéticos: la operadora es ficticia.",
  fictitiousTag: "ficticia",
  syntheticDemoTag: "demo sintética",

  optInPoster: "Activa Cuadrilla en tu WhatsApp: envía ALTA a este número. Vas a recibir tus órdenes del día, respuestas del manual y avisos de tus casos. Para darte de baja, envía BAJA.",
  welcome,
  optInRequired: "Para activar Cuadrilla envía ALTA.",
  unknownNumber: "Este número es de uso interno de la operadora.",
  optOutConfirmed: "Listo, ya no vas a recibir mensajes de Cuadrilla. Si quieres volver, envía ALTA.",
  shiftRegistered: (untilText) => `Turno registrado hasta las ${untilText}. Mientras tanto, los casos de tu equipo te llegan por aquí.`,
  supervisorNoCase: "No tienes un caso tomado en este momento. Cuando te llegue uno, toca Tomar caso para atenderlo.",
  voiceUnclear: "No te entendí bien el audio; ¿me lo repites más despacio o me lo escribes?",
  voiceTooLong: "Manda notas de voz de menos de 2 minutos.",
  voiceFailed: "No pude procesar el audio; intenta de nuevo o escríbeme el mensaje.",
  unsupportedMedia: "Por aquí solo puedo recibir texto, notas de voz y fotos.",
  imageTooLarge: "La imagen pesa demasiado: mándala como foto, no como documento.",
  imageUnreadable: "No pude abrir esa imagen: tómala de nuevo y mándala como foto.",
  servicePaused: "Cuadrilla está en pausa en este momento; intenta de nuevo en un rato. Si hay un riesgo de seguridad, escríbelo: la alerta a tu supervisor sigue activa.",
  agentFallback: "No pude procesar tu mensaje, intenta de nuevo en un momento.",
  turnCap: "Por ahora llegué al límite de consultas; intenta de nuevo más tarde. Si es urgente, consulta a tu supervisor.",
  guardrailRefusal: "Eso no lo puedo responder por aquí. Tu supervisor de turno va a revisar tu consulta.",
  closeNotComplete,
  buttonExpired: "Ese botón ya no está disponible. Si necesitas algo, escríbeme.",
  caseAlreadyClosed: "Ese caso ya está cerrado; no hace falta hacer nada más.",
  joinCodeInvalid: "Ese código no es válido o ya venció. Genera uno nuevo en la consola de la demo.",
  leaseInUse: "Este número ya está en uso en otra demo.",
  leaseBound: (personFirstName, hours) => `Listo: este teléfono quedó ligado a la demo como ${personFirstName} durante ${hours} horas. Escribe como lo haría esa persona.`,

  safetyInstruction:
    "Detén el trabajo ahora. No toques el cable, el poste ni la escalera si están en contacto con algo energizado. Aléjate al menos 10 metros, avisa a las personas que estén cerca y señaliza la zona si puedes hacerlo sin riesgo. Avisa a tu supervisor y no reanudes el trabajo hasta que te lo autorice.",

  caseOpened: (name) => `Escalé tu caso a ${name} (supervisión de turno). Te aviso en cuanto lo tome.`,
  caseReassigned: (name) => `Tu caso pasó a ${name} (supervisión de respaldo). Te aviso en cuanto lo tome.`,
  caseToZoneChief: "Ningún supervisor pudo tomar tu caso a tiempo, así que ya avisé por correo a la jefatura de zona. Te aviso en cuanto alguien lo tome.",
  caseTaken: (name) => `${name} tomó tu caso. Lo que escribas sobre esta orden le llega directo.`,
  safetyCaseOpened: "Ya avisé a tu supervisor de turno y a la jefatura de zona. La orden queda en espera hasta que tu supervisor cierre el caso.",

  caseTakenByOther: (name) => `Ya lo tomó ${name}.`,
  caseBrief,
  caseClosedConfirmation: (workOrderNumber, installerFirstName) => `Cerraste el caso de la orden ${workOrderNumber}. El asistente retoma con ${installerFirstName}.`,
  relayPrefix: (firstName, role) => `${firstName} (${role === "SUPERVISOR" ? "supervisor" : "instalador"}): `,

  orderChoicePrompt: "Tienes varias órdenes pendientes hoy. ¿Sobre cuál es tu mensaje?",
  orderChoiceRow: ({ workOrderNumber, windowText, neighborhood }: OrderChoiceInput) => ({ title: `OT ${workOrderNumber}`, description: `${windowText} · ${neighborhood}` }),
  caseChoicePrompt: "Tienes más de un caso tomado. ¿Sobre cuál es tu mensaje?",
  caseChoiceRow: ({ caseLabel, workOrderNumber, installerFirstName }: CaseChoiceInput) => ({ title: `Caso ${caseLabel}`, description: `Orden ${workOrderNumber} · ${installerFirstName}` }),
  itemChoicePrompt: "¿Para cuál foto del checklist es esta imagen?",

  rejectReason,
  photoInReview: "No pude validar bien esta foto, así que tu supervisor la va a revisar. Si puedes, mándame otra más clara.",

  checklistItem: CHECKLIST_ITEM,
  hazard: {
    ELECTRICAL: "riesgo eléctrico",
    POLE: "poste dañado o inclinado",
    HEIGHT: "riesgo de caída en altura",
    WEATHER: "tormenta eléctrica",
    ANIMAL: "animal agresivo",
    THREAT: "amenaza a la persona",
    OTHER: "otro riesgo en el sitio",
  },
  symptom: SYMPTOM,
  caseReason,
};
