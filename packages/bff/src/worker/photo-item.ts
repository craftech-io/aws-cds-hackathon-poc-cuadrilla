// The item of a photo the installer sent without a word (FL-046, FL-039): decided by code, never by the
// model, which never sees the photo. One photo item still to pass is the one the agent's request named;
// with several, the worker asks which with the fixed `itemChoicePrompt` and CHOOSE_ITEM buttons (no turn,
// no model text for G2 to refuse); the tap brings the photo back with the chosen item
// (turns/facts.ts `chosenPhotoAttachment`). A caption that is an item's button title ("Etiqueta de la ONU",
// what the tour's quick photos carry) names it; any other caption goes to the agent as before.
import { type ChecklistItemStatus, PhotoItem } from "@cuadrilla/shared";
import { PHOTO_ITEM_BUTTONS } from "../copy/buttons";
import type { Connector } from "../connector/ports";

const DONE: ReadonlySet<ChecklistItemStatus> = new Set<ChecklistItemStatus>(["PASSED", "OVERRIDDEN"]);

export type PhotoItemDecision = { readonly kind: "KNOWN"; readonly item: PhotoItem } | { readonly kind: "ASK"; readonly items: readonly PhotoItem[] } | { readonly kind: "AGENT" };

const plain = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The photo item a caption names by its button title (es or en, case, accents and punctuation ignored). */
export function itemNamedBy(caption: string): PhotoItem | undefined {
  const said = plain(caption);
  return PhotoItem.options.find((item) => said === plain(PHOTO_ITEM_BUTTONS[item].es) || said === plain(PHOTO_ITEM_BUTTONS[item].en));
}

/** Photo items of the order not passed yet, in the checklist's order. */
export async function pendingPhotoItems(workOrders: Pick<Connector["workOrders"], "listChecklist">, workOrderId: string): Promise<PhotoItem[]> {
  const entries = await workOrders.listChecklist(workOrderId);
  return entries.flatMap((entry) => {
    const item = PhotoItem.safeParse(entry.item);
    return item.success && !DONE.has(entry.status) ? [item.data] : [];
  });
}

/** What to do with a photo that came without a caption: its item, the question, or the agent (nothing pending). */
export async function photoItemDecision(workOrders: Pick<Connector["workOrders"], "listChecklist">, workOrderId: string): Promise<PhotoItemDecision> {
  const pending = await pendingPhotoItems(workOrders, workOrderId);
  const [only] = pending;
  if (pending.length === 1 && only !== undefined) return { kind: "KNOWN", item: only };
  return pending.length > 1 ? { kind: "ASK", items: pending } : { kind: "AGENT" };
}
