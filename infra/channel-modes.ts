// Channel transports of the stage (ADR-0002, docs/architecture-integrations.md §4, docs/build-plan.md WP-02).
//
// Email always runs `live` (SES end to end, outbound only: this app never receives mail, ADR-0003).
// WhatsApp declares the TRANSPORTS the stage has: `simulated` (the phone simulator of the console
// feeds the same inbound normalizer as the SNS payload of End User Messaging Social) until the
// WhatsApp Business Account is connected (docs/pending.md P-01), and `["simulated", "live"]` after.
// Which transport a message takes is decided per world (`Isps/SETTINGS.whatsappMode`) and per
// recipient; the simulator exists in every world with `whatsappMode = simulated`.
//
// Exposed as a Linkable so every Lambda reads them with `readLinked("ChannelModes", …)`, never from
// `process.env`. `npm run channels:check-modes` (CI) fails when `"live"` is among the WhatsApp
// transports while P-01 is still open in docs/pending.md, so keep the literals exactly as below.

export type WhatsAppTransport = "live" | "simulated";

export interface ChannelModesConfig {
  readonly email: "live";
  readonly whatsapp: { readonly transports: readonly WhatsAppTransport[] };
}

export const channelModes = {
  email: "live",
  whatsapp: { transports: ["simulated"] }, // add "live" only after docs/pending.md P-01 is closed
} as const satisfies ChannelModesConfig;

export const ChannelModes = new sst.Linkable("ChannelModes", {
  properties: channelModes,
});
