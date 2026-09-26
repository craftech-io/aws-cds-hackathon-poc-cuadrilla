// Labels of every WhatsApp button and list the product sends, with the Cloud API limits baked in
// (docs/architecture-integrations.md §4.1 and §4.5). Every label fits the tightest place it can go:
// a template button is reused as an interactive reply button in plan B ("TURNO" / "ÓRDENES"), so
// even template buttons fit the 20 characters of a reply button, and no adapter ever truncates.
import { PhotoItem, type Verdict, WaButtonAction } from "@cuadrilla/shared";

/** WhatsApp Cloud API limits, in characters (code points) unless stated. */
export const WHATSAPP_LIMITS = {
  /** Quick-reply button of a template. */
  templateButton: 25,
  /** Title of an interactive reply button. */
  replyButton: 20,
  /** Reply buttons per interactive message. */
  replyButtonsMax: 3,
  /** Label of the button that opens an interactive list. */
  listButton: 20,
  listRowTitle: 24,
  listRowDescription: 72,
  /** Rows per interactive list, over all its sections. */
  listRowsMax: 10,
  interactiveBody: 1024,
  templateBody: 1024,
  textBody: 4096,
} as const;

export interface ButtonLabel {
  readonly es: string;
  /** English gloss for the simulator (ADR-0013); never sent. */
  readonly en: string;
}

/** Label of every button action. The choice actions label the button that opens their list. */
export const BUTTON_LABELS: Readonly<Record<WaButtonAction, ButtonLabel>> = {
  VIEW_ORDERS: { es: "Ver órdenes", en: "View orders" },
  TAKE_CASE: { es: "Tomar caso", en: "Take case" },
  DECLINE_CASE: { es: "No puedo", en: "Can't" },
  CLOSE_CASE: { es: "Cerrar caso", en: "Close case" },
  VIEW_REPLY: { es: "Ver respuesta", en: "View reply" },
  CHOOSE_ORDER: { es: "Elegir orden", en: "Choose order" },
  CHOOSE_CASE: { es: "Elegir caso", en: "Choose case" },
  CHOOSE_ITEM: { es: "Elegir foto", en: "Choose photo" },
  // The design names it "Consultar a mi supervisor"; the reply button holds 20 characters.
  CONSULT_SUPERVISOR: { es: "Consultar supervisor", en: "Ask supervisor" },
  NO_THANKS: { es: "No, gracias", en: "No, thanks" },
  CUSTOMER_OK: { es: "Cliente conforme", en: "Customer OK" },
  CLOSE_INSTALLATION: { es: "Cerrar instalación", en: "Close install" },
};

/** Reply-button title of each photo item when the agent offers `CHOOSE_ITEM` buttons. */
export const PHOTO_ITEM_BUTTONS: Readonly<Record<PhotoItem, ButtonLabel>> = {
  POWER_READING_PHOTO: { es: "Lectura del medidor", en: "Meter reading" },
  ONU_LABEL_PHOTO: { es: "Etiqueta de la ONU", en: "ONU label" },
  ROSETTE_PHOTO: { es: "Roseta instalada", en: "Installed rosette" },
};

/**
 * Title of a reply button: the item's label for `CHOOSE_ITEM` with an item, the action's otherwise.
 * `item` only makes sense with `CHOOSE_ITEM`.
 */
export function buttonTitle(action: WaButtonAction, item?: PhotoItem, language: keyof ButtonLabel = "es"): string {
  if (item !== undefined && action !== "CHOOSE_ITEM") throw new Error(`an item only goes with CHOOSE_ITEM, not ${action}`);
  const label = item === undefined ? BUTTON_LABELS[action] : PHOTO_ITEM_BUTTONS[PhotoItem.parse(item)];
  return label[language];
}

/** Number of characters as WhatsApp counts them (code points, so "ó" is one). */
export function charCount(text: string): number {
  return [...text].length;
}

/** Whether `text` fits a WhatsApp field of `limit` characters and is not blank. */
export function fitsLimit(text: string, limit: number): boolean {
  return text.trim() !== "" && charCount(text) <= limit;
}

/** Reaction the validator puts on the photo's message before the agent writes (FL-103). */
export const VERDICT_REACTIONS: Readonly<Record<Verdict, string>> = {
  PASS: "✅",
  REJECT: "\u{1F501}",
  UNSURE: "\u{1F501}",
};
