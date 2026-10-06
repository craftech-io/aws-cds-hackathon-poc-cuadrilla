import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { OPT_IN_TEXT_VERSION } from "../../copy/es-MX";
import { setPersonActive } from "../people/people";
import { DEMO, GUEST_07, QA, serviceWorld } from "../people/testing";
import { channelActions } from "./channel-actions";
import { recordConsent, revokeConsent } from "./consent";

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
}

const ALTA_AT = "2026-10-13T08:10:00-06:00";

describe("record_consent: opt-in with \"ALTA\" [FL-002]", () => {
  it("[FL-002] the channel records the opt-in with medium WHATSAPP_KEYWORD, the poster's version and the message's instant", async () => {
    const world = await serviceWorld(DEMO);
    const { julian } = world.ids;
    const result = await recordConsent(world.deps, world.channel("wa-in-alta"), { personId: julian, textVersion: OPT_IN_TEXT_VERSION, atSim: ALTA_AT, sourceMessageId: "wamid.A1" });
    expect(result).toMatchObject({ changed: true, consent: { status: "GRANTED", medium: "WHATSAPP_KEYWORD", textVersion: "v001", grantedAtSim: ALTA_AT, changes: 1 } });
    const stored = await world.deps.connector.people.getConsent(julian);
    expect(stored?.history).toMatchObject([{ field: "consent", to: "GRANTED", actor: `PERSON:${julian}`, atSim: ALTA_AT, reason: "WHATSAPP_KEYWORD" }]);
    expect((await world.decisions()).filter((row) => row.action === "CONSENT_GRANTED")).toMatchObject([
      { decision: "ACTION", actor: "CHANNEL", messageId: "wamid.A1", refs: { personId: julian }, detail: { medium: "WHATSAPP_KEYWORD", textVersion: "v001" } },
    ]);
  });

  it("[FL-002] a second ALTA with the same text writes nothing; the channel's adapter runs the same handler", async () => {
    const world = await serviceWorld(DEMO);
    const actions = channelActions(world.deps);
    const input = { clockId: world.clockId, ispId: world.ispId, personId: world.ids.julian, atSim: ALTA_AT, sourceMessageId: "wamid.A1", eventId: "wa-in-1", textVersion: OPT_IN_TEXT_VERSION };
    await actions.recordConsent(input);
    await actions.recordConsent({ ...input, sourceMessageId: "wamid.A2", eventId: "wa-in-2" });
    expect((await world.deps.connector.people.getConsent(world.ids.julian))?.history).toHaveLength(1);
    expect((await world.decisions()).filter((row) => row.action === "CONSENT_GRANTED")).toHaveLength(1);
  });

  it("[FL-002] the console and QA record the medium from the caller, at the world's now; only the channel brings a message", async () => {
    const world = await serviceWorld(DEMO);
    expect(await recordConsent(world.deps, world.console(), { personId: world.ids.julian })).toMatchObject({ consent: { medium: "CONSOLE", grantedAtSim: "2026-10-13T09:20:00-06:00" } });
    expect(await refusal(recordConsent(world.deps, world.console(), { personId: world.ids.julian, atSim: ALTA_AT }))).toMatchObject({ reason: "CHANNEL_ONLY_FIELD" });
    expect(await refusal(recordConsent(world.deps, world.console(), { personId: world.ids.julian, medium: "SEED" }))).toMatchObject({ code: "INVALID", reason: "VALIDATION" });
    const qa = await serviceWorld(QA);
    expect(await recordConsent(qa.deps, qa.qa(), { personId: qa.ids.julian })).toMatchObject({ consent: { medium: "QA" } });
  });

  it("[FL-002] refuses an unknown text version, a person off the allow list, OPS, and a person of another world", async () => {
    const demo = await serviceWorld(DEMO);
    const guest = await serviceWorld(GUEST_07, demo);
    expect(await refusal(recordConsent(demo.deps, demo.channel(), { personId: demo.ids.julian, textVersion: "v999" }))).toMatchObject({ reason: "UNKNOWN_TEXT_VERSION" });
    expect(await refusal(recordConsent(demo.deps, demo.console("OPS", "usr-ops"), { personId: demo.ids.julian }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await refusal(recordConsent(guest.deps, guest.channel(), { personId: demo.ids.julian }))).toMatchObject({ code: "NOT_FOUND" });
    await setPersonActive(demo.deps, demo.console(), { personId: demo.ids.julian, active: false });
    expect(await refusal(recordConsent(demo.deps, demo.channel(), { personId: demo.ids.julian }))).toMatchObject({ reason: "PERSON_INACTIVE" });
  });
});

describe("revoke_consent: \"BAJA\" [FL-005]", () => {
  it("[FL-005] revokes with a dated history and audits CONSENT_REVOKED; a second BAJA is a no-op", async () => {
    const world = await serviceWorld(DEMO);
    const { rogelio } = world.ids;
    const actions = channelActions(world.deps);
    const input = { clockId: world.clockId, ispId: world.ispId, personId: rogelio, atSim: "2026-10-13T12:00:00-06:00", sourceMessageId: "wamid.B1", eventId: "wa-in-b1" };
    await actions.revokeConsent(input);
    const stored = await world.deps.connector.people.getConsent(rogelio);
    expect(stored).toMatchObject({ status: "REVOKED", revokedAtSim: "2026-10-13T12:00:00-06:00" });
    expect(stored?.history.at(-1)).toMatchObject({ field: "consent", from: "GRANTED", to: "REVOKED", actor: `PERSON:${rogelio}`, reason: "WHATSAPP_KEYWORD" });
    expect(await revokeConsent(world.deps, world.channel(), { personId: rogelio })).toMatchObject({ changed: false, consent: { status: "REVOKED" } });
    expect((await world.decisions()).filter((row) => row.action === "CONSENT_REVOKED")).toMatchObject([{ messageId: "wamid.B1", detail: { via: "WHATSAPP_KEYWORD" } }]);
  });

  it("[FL-005] the console records an opt-out given another way; someone without opt-in is left as is", async () => {
    const world = await serviceWorld(DEMO);
    expect(await revokeConsent(world.deps, world.console(), { personId: world.ids.adriana, reason: "pidió la baja por teléfono" })).toMatchObject({ changed: true, consent: { status: "REVOKED" } });
    expect((await world.deps.connector.people.getConsent(world.ids.adriana))?.history.at(-1)).toMatchObject({ actor: "USER:usr-adriana", reason: "pidió la baja por teléfono" });
    expect(await revokeConsent(world.deps, world.console(), { personId: world.ids.julian })).toMatchObject({ changed: false, consent: { status: "NONE" } });
  });
});

describe("register_shift through the channel's adapter [FL-074]", () => {
  it("[FL-074] \"TURNO\" answers the window's closing instant", async () => {
    const world = await serviceWorld(DEMO);
    const result = await channelActions(world.deps).registerShift({ clockId: world.clockId, ispId: world.ispId, personId: world.ids.adriana, atSim: "2026-10-13T07:05:00-06:00", sourceMessageId: "wamid.T1", eventId: "wa-in-t1" });
    expect(result).toEqual({ closesAtSim: "2026-10-14T07:05:00-06:00" });
  });
});
