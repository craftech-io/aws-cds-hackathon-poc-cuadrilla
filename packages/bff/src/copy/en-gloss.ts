// English gloss of every fixed text and template (ADR-0013): the simulator shows it under an "EN"
// toggle so a judge who does not read Spanish follows the story. It is never sent to anyone; the
// staff always receive es-MX.ts. Same interface, so a text added in Spanish without its gloss is a
// compile error.
import type { PhotoItem, RejectReason, TemplateName } from "@cuadrilla/shared";
import { inChecklistOrder, listInEnglish } from "./helpers";
import type { CaseBriefInput, CaseReasonInput, CopyPack, StaffRole } from "./types";

const PHOTO_SUBJECT: Readonly<Record<PhotoItem, string>> = {
  POWER_READING_PHOTO: "the meter's screen",
  ONU_LABEL_PHOTO: "the ONU label",
  ROSETTE_PHOTO: "the rosette",
};

const NOT_READABLE: Readonly<Record<PhotoItem, string>> = {
  POWER_READING_PHOTO: "the value can't be read",
  ONU_LABEL_PHOTO: "the serial can't be read",
  ROSETTE_PHOTO: "it can't be seen well",
};

const PHOTO_SHORT: Readonly<Record<PhotoItem, string>> = {
  POWER_READING_PHOTO: "meter photo",
  ONU_LABEL_PHOTO: "label photo",
  ROSETTE_PHOTO: "rosette photo",
};

function rejectReason(reason: RejectReason, item: PhotoItem): string {
  const subject = PHOTO_SUBJECT[item];
  const notReadable = NOT_READABLE[item];
  switch (reason) {
    case "BLURRY":
      return `The photo is blurry and ${notReadable}: steady the phone, tap the screen to focus and take it again.`;
    case "GLARE":
      return `There is glare on ${subject} and ${notReadable}: tilt the phone a little and turn the flash off.`;
    case "CROPPED":
      return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} is cut off in the photo: step back so it fits and take it again.`;
    case "DARK":
      return `The photo is too dark and ${notReadable}: find more light, for example near a window, and take it again.`;
    case "WRONG_SUBJECT":
      return `That photo doesn't show ${subject}. Send me one where it is fully visible.`;
    case "OUT_OF_RANGE_LOW":
      return "The reading is below the accepted range for this zone, so the job can't be closed: clean the connectors at both ends, check splices and cable bends, and measure again.";
    case "OUT_OF_RANGE_HIGH":
      return "The reading is above the accepted range (overload), so the job can't be closed: check the measurement and, if it stays the same, ask your supervisor.";
    case "WRONG_WAVELENGTH":
      return "The meter is not set to 1490 nm: switch it to 1490 nm, measure again and resend the photo.";
    case "SERIAL_MISMATCH":
      return "The label is not from this order's ONU: check that you installed the right unit and send a photo of its label.";
    case "READING_MISMATCH":
      return "The value in the photo doesn't match what the network reports for this ONU: measure again at this order's rosette and send the new photo.";
    case "DUPLICATE_EVIDENCE":
      return "That photo was already used as evidence on another order: take a new photo right here.";
    case "UNREADABLE":
      return `In the photo ${notReadable}: remove whatever covers ${subject} and shoot it straight on, in focus.`;
  }
}

const SYMPTOM: CopyPack["symptom"] = {
  NO_PON_LIGHT: "PON light off",
  LOW_POWER: "power out of range",
  NO_POWER: "ONU without power",
  NOT_PROVISIONED: "ONU not provisioned",
  NO_BROWSING: "ONU online but no browsing",
  OTHER: "unresolved fault",
};

const CHECKLIST_ITEM: CopyPack["checklistItem"] = {
  ONU_ONLINE: "the ONU online with power in range",
  POWER_READING_PHOTO: "the meter reading photo",
  ONU_LABEL_PHOTO: "the ONU label photo",
  ROSETTE_PHOTO: "the installed rosette photo",
  CUSTOMER_OK: "the customer's sign-off",
};

function caseReason({ reason, symptom, item }: CaseReasonInput): string {
  switch (reason) {
    case "OUT_OF_MANUAL":
      return "question the manual doesn't cover";
    case "DIAGNOSIS_ATTEMPTS":
      return `${SYMPTOM[symptom ?? "OTHER"]} after 3 steps`;
    case "PHOTO_ATTEMPTS":
      return `${item === undefined ? "photo" : PHOTO_SHORT[item]} rejected 3 times`;
    case "INSTALLER_ASKED":
      return "asked to talk to their supervisor";
    case "NOT_PROVISIONED":
      return "ONU not provisioned in the system";
    case "DENIED_TOPIC":
      return "question on a topic Cuadrilla doesn't answer";
    case "PROMPT_INJECTION":
      return "message with suspicious instructions";
    case "SAFETY":
      return "safety hazard on site";
    case "CERTIFICATE_UNDELIVERED":
      return "the certificate didn't reach the customer";
    case "OTHER":
      return "other reason";
  }
}

function welcome(firstName: string, role: StaffRole): string {
  if (role === "SUPERVISOR") {
    return `All set, ${firstName}! Cuadrilla is on. Your crew's cases will arrive here with the Take case and Can't buttons. Send TURNO when your shift starts; to stop receiving messages, send BAJA.`;
  }
  return `All set, ${firstName}! Cuadrilla, the operator's field assistant on WhatsApp, is on. Text me or send voice notes with your questions about the order, and evidence photos when I ask for them. To stop receiving messages, send BAJA.`;
}

function caseBrief({ caseLabel, workOrderNumber, installerFirstName, reasonText, summary }: CaseBriefInput): string {
  return [
    `Case ${caseLabel} · order ${workOrderNumber}`,
    `Installer: ${installerFirstName}`,
    `Reason: ${reasonText}`,
    `Summary: ${summary}`,
    `What you write here reaches ${installerFirstName}. Tap Close case when you are done.`,
  ].join("\n");
}

export const enGloss: CopyPack = {
  brandLine: (partnerName) => (partnerName === undefined ? "Cuadrilla · Powered by Craftech" : `Cuadrilla for ${partnerName} · Powered by Craftech`),
  syntheticDemoNotice: (partnerName) => `Synthetic demo: the manual, policies and data are made up and are not the actual policies of ${partnerName}.`,
  fictitiousOperatorNotice: "Demo with 100% synthetic data: the operator is fictitious.",
  fictitiousTag: "fictitious",
  syntheticDemoTag: "synthetic demo",

  optInPoster: "Turn on Cuadrilla in your WhatsApp: send ALTA to this number. You will get your orders of the day, answers from the manual and updates on your cases. To opt out, send BAJA.",
  welcome,
  optInRequired: "To turn on Cuadrilla, send ALTA.",
  unknownNumber: "This number is for the operator's internal use.",
  optOutConfirmed: "Done, you will no longer receive messages from Cuadrilla. To come back, send ALTA.",
  shiftRegistered: (untilText) => `Shift registered until ${untilText}. Until then, your crew's cases reach you here.`,
  supervisorNoCase: "You have no case taken right now. When one arrives, tap Take case to handle it.",
  voiceUnclear: "I didn't catch the audio; can you repeat it more slowly or type it?",
  voiceTooLong: "Send voice notes shorter than 2 minutes.",
  voiceFailed: "I couldn't process the audio; try again or type your message.",
  unsupportedMedia: "Here I can only receive text, voice notes and photos.",
  imageTooLarge: "The image is too large: send it as a photo, not as a document.",
  imageUnreadable: "I couldn't open that image: take it again and send it as a photo.",
  servicePaused: "Cuadrilla is paused right now; try again in a while. If there is a safety hazard, write it: the alert to your supervisor still works.",
  agentFallback: "I couldn't process your message, try again in a moment.",
  turnCap: "I've reached the question limit for now; try again later. If it's urgent, ask your supervisor.",
  guardrailRefusal: "I can't answer that here. Your shift supervisor will review your question.",
  closeNotComplete: (missing) => {
    const items = inChecklistOrder(missing).map((item) => CHECKLIST_ITEM[item]);
    if (items.length === 0) return "I can't close the installation yet: the order is on hold until your supervisor closes its case.";
    return `I can't close the installation yet. Missing: ${listInEnglish(items)}.`;
  },
  buttonExpired: "That button is no longer available. If you need something, write to me.",
  caseAlreadyClosed: "That case is already closed; nothing else to do.",
  joinCodeInvalid: "That code is not valid or has expired. Generate a new one in the demo console.",
  leaseInUse: "This number is already in use in another demo.",
  leaseBound: (personFirstName, hours) => `Done: this phone is bound to the demo as ${personFirstName} for ${hours} hours. Write as that person would.`,

  safetyInstruction:
    "Stop work now. Don't touch the cable, the pole or the ladder if they are in contact with anything energized. Move at least 10 meters away, warn the people nearby and mark off the area if you can do it safely. Tell your supervisor and don't resume work until they authorize it.",

  caseOpened: (name) => `I escalated your case to ${name} (shift supervisor). I'll let you know as soon as they take it.`,
  caseReassigned: (name) => `Your case moved to ${name} (backup supervisor). I'll let you know as soon as they take it.`,
  caseToZoneChief: "No supervisor could take your case in time, so I emailed the zone chief. I'll let you know as soon as someone takes it.",
  caseTaken: (name) => `${name} took your case. What you write about this order goes straight to them.`,
  safetyCaseOpened: "I alerted your shift supervisor and the zone chief. The order stays on hold until your supervisor closes the case.",

  caseTakenByOther: (name) => `${name} already took it.`,
  caseBrief,
  caseClosedConfirmation: (workOrderNumber, installerFirstName) => `You closed the case of order ${workOrderNumber}. The assistant picks up again with ${installerFirstName}.`,
  relayPrefix: (firstName, role) => `${firstName} (${role === "SUPERVISOR" ? "supervisor" : "installer"}): `,

  orderChoicePrompt: "You have several pending orders today. Which one is your message about?",
  orderChoiceRow: ({ workOrderNumber, windowText, neighborhood }) => ({ title: `WO ${workOrderNumber}`, description: `${windowText} · ${neighborhood}` }),
  caseChoicePrompt: "You have more than one case taken. Which one is your message about?",
  caseChoiceRow: ({ caseLabel, workOrderNumber, installerFirstName }) => ({ title: `Case ${caseLabel}`, description: `Order ${workOrderNumber} · ${installerFirstName}` }),
  itemChoicePrompt: "Which checklist photo is this image for?",

  rejectReason,
  photoInReview: "I couldn't validate this photo well, so your supervisor will review it. If you can, send me a clearer one.",

  checklistItem: CHECKLIST_ITEM,
  hazard: {
    ELECTRICAL: "electrical hazard",
    POLE: "damaged or leaning pole",
    HEIGHT: "fall-from-height hazard",
    WEATHER: "thunderstorm",
    ANIMAL: "aggressive animal",
    THREAT: "threat to the person",
    OTHER: "other hazard on site",
  },
  symptom: SYMPTOM,
  caseReason,
};

/** English gloss of the six `UTILITY` template bodies (templates.ts), same placeholders. */
export const TEMPLATE_GLOSS: Readonly<Record<TemplateName, string>> = {
  ordenes_del_dia: "Hi {{1}}, today you have {{2}} installations assigned on your route. The first appointment is from {{3}}. Tap View orders to get the details of each one.",
  caso_escalado: "You have a new case from your crew: {{1}}. Installer {{2}} needs support on order {{3}} for this reason: {{4}}. Can you take it now?",
  caso_reasignado: "The shift supervisor didn't answer case {{1}}. Installer {{2}} is still waiting for support on order {{3}} for this reason: {{4}}. Can you take it now?",
  alerta_seguridad: "Safety alert on order {{1}}. Installer {{2}} reported this hazard: {{3}}. They already received the manual's safety instruction. Can you take it now?",
  respuesta_supervisor: "Your supervisor {{1}} replied about order {{2}}. Tap View reply to read the full message.",
  acta_instalacion: "The certificate for order {{1}} is ready. It was already sent to the customer and to the operations mailbox.",
};
