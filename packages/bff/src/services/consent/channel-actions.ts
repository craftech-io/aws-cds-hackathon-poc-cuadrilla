// The deterministic handlers behind the channel's keywords (`ChannelActions` of
// channels/whatsapp/ports.ts): "ALTA" → `record_consent`, "BAJA" → `revoke_consent`, "TURNO" →
// `register_shift`, each with `caller CHANNEL` of the sender's world, at the simulated instant of the
// inbound message and with its `wamid`. InboundWhatsApp builds this once per container.
import type { Caller } from "@cuadrilla/shared";
import type { ChannelActionInput, ChannelActions } from "../../channels/whatsapp/ports";
import type { ServiceDeps } from "../people/direct-call";
import { registerShift } from "../people/shift";
import { recordConsent, revokeConsent } from "./consent";

/** The channel's caller for a message of `input`'s world. */
export function channelCaller(input: Pick<ChannelActionInput, "ispId" | "clockId" | "eventId">): Caller {
  return { kind: "CHANNEL", ispId: input.ispId, clockId: input.clockId, eventId: input.eventId };
}

function messageOf(input: ChannelActionInput) {
  return { personId: input.personId, atSim: input.atSim, sourceMessageId: input.sourceMessageId };
}

export function channelActions(deps: ServiceDeps): ChannelActions {
  return {
    async recordConsent(input) {
      await recordConsent(deps, channelCaller(input), { ...messageOf(input), textVersion: input.textVersion });
    },
    async revokeConsent(input) {
      await revokeConsent(deps, channelCaller(input), messageOf(input));
    },
    async registerShift(input) {
      const { closesAtSim } = await registerShift(deps, channelCaller(input), messageOf(input));
      return { closesAtSim };
    },
  };
}
