// Which existing message a request with a fixed id is answered from, and when a safety message is sent
// again (ADR-0016) [W3R1 B2]: only the instruction and the supervisor's alert, only while unconfirmed.
import { describe, expect, it } from "vitest";
import { CLOCK, ISP } from "../connector/testing";
import type { Message } from "../domain/conversations";
import { createLogger } from "../lib/log";
import { pipelineKit } from "./testing";
import type { WhatsAppSendRequest } from "./types";
import { MAX_SAFETY_RESENDS, existingOrResend, resendId } from "./unconfirmed";

const log = createLogger({ level: "error", sink: () => undefined });
const ID = "safety-0123456789abcdef0123456789abcdef01234567";

function request(kind: WhatsAppSendRequest["kind"]): WhatsAppSendRequest {
  return { channel: "WHATSAPP", personId: "inst-rogelio", kind, author: "SYSTEM", eventAtSim: "2026-10-13T15:10:00-06:00", messageId: ID, text: "Aléjate del poste." } as WhatsAppSendRequest;
}

async function stored(kit: Awaited<ReturnType<typeof pipelineKit>>, messageId: string, kind: Message["kind"], fields: Partial<Message>): Promise<void> {
  await kit.world.connector.conversations.appendMessage({ messageId, personId: "inst-rogelio", ispId: ISP, clockId: CLOCK, direction: "OUT", channel: "WHATSAPP", content: "TEXT", kind, status: "QUEUED", author: "SYSTEM", simulated: true, sentAtSim: "2026-10-13T15:10:00-06:00", ...fields });
}

describe("[W3R1 B2] unconfirmed safety messages", () => {
  it("sends a QUEUED or FAILED safety message without a provider id again under the next id", async () => {
    const kit = await pipelineKit();
    await stored(kit, ID, "SAFETY_INSTRUCTION", { status: "QUEUED" });
    expect(await existingOrResend(kit.world.connector, request("SAFETY_INSTRUCTION"), log)).toEqual({ request: { ...request("SAFETY_INSTRUCTION"), messageId: resendId(ID, 1) } });
    await stored(kit, resendId(ID, 1), "SAFETY_INSTRUCTION", { status: "FAILED" });
    expect(await existingOrResend(kit.world.connector, request("SAFETY_INSTRUCTION"), log)).toMatchObject({ request: { messageId: resendId(ID, 2) } });
  });

  it("replays what the transport confirmed or the policy decided, every other kind, and the last resend once the attempts are spent", async () => {
    const kit = await pipelineKit();
    await stored(kit, ID, "SAFETY_INSTRUCTION", { status: "QUEUED", providerMessageId: "wamid.SIM.1" });
    expect(await existingOrResend(kit.world.connector, request("SAFETY_INSTRUCTION"), log)).toMatchObject({ replay: { messageId: ID } });
    const other = await pipelineKit();
    await stored(other, ID, "REPLY", { status: "QUEUED" });
    expect(await existingOrResend(other.world.connector, request("REPLY"), log)).toMatchObject({ replay: { messageId: ID } });
    const denied = await pipelineKit();
    await stored(denied, ID, "SAFETY_ALERT", { status: "DENIED" });
    expect(await existingOrResend(denied.world.connector, request("SAFETY_ALERT"), log)).toMatchObject({ replay: { status: "DENIED" } });
    const spent = await pipelineKit();
    for (let attempt = 0; attempt <= MAX_SAFETY_RESENDS; attempt += 1) await stored(spent, attempt === 0 ? ID : resendId(ID, attempt), "SAFETY_ALERT", { status: "QUEUED" });
    expect(await existingOrResend(spent.world.connector, request("SAFETY_ALERT"), log)).toMatchObject({ replay: { messageId: resendId(ID, MAX_SAFETY_RESENDS) } });
  });
});
