// What `/join` shows (docs/design-brief.md §7, FL-089): the opt-in poster of the product with the
// keyword a person sends ("ALTA", FL-002) and a QR. The stage's WhatsApp runs on the simulated
// transport (the live one is enabled by configuration, P-01, ADR-0028), so the QR opens the console's phone
// simulator, where the keyword is sent as the person; the simulator asks for a sign-in like any other
// console view. Pure: the view passes the page's origin.
import { ROUTES } from "../../routes";

/** What a person sends to opt in; the same keyword the BFF's poster carries (people.joinPoster). */
export const JOIN_KEYWORD = "ALTA";

/** The console's phone simulator, from the route table. */
export const SIMULATOR_PATH = ROUTES.find((route) => route.id === "simulator")?.patterns[0] ?? "/app/simulator";

/** The address the QR carries: the simulator on this same site, never another host. */
export function simulatorUrl(origin: string): string {
  return new URL(SIMULATOR_PATH, origin).toString();
}

