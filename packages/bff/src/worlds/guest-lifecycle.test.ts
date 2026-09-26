import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { evidencePhotoKey, simMediaKey } from "@cuadrilla/shared/media/keys";
import { openCase } from "../connector/testing";
import { buildWorld } from "./factory";
import { destroyGeneration, randomSuffix, signupGenerationDestroyer } from "./guest-lifecycle";
import { SIGNUP_CLOCK, SIGNUP_ISP, SIGNUP_USER, allRows, worldHarness } from "./testing";

const OTHER_ISP = "isp-guest-s261001zzzzz";
const OTHER_CLOCK = `GUEST#${OTHER_ISP}`;
const OTHER_USER = "usr-g01K60000000000000000000002";

async function twoGenerationsAndAnInvitedWorld() {
  const world = worldHarness();
  await buildWorld(world.factoryDeps(), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
  await buildWorld(world.factoryDeps(), { ispId: OTHER_ISP, origin: "SIGNUP", ownerUserId: OTHER_USER });
  await buildWorld(world.factoryDeps(), { ispId: "isp-guest-07", origin: "INVITED" });
  for (const clockId of [SIGNUP_CLOCK, OTHER_CLOCK, "GUEST#isp-guest-07"]) {
    world.objects.put("Media", simMediaKey(clockId, 1, "up-voice-1"));
    world.objects.put("Evidence", evidencePhotoKey(clockId, 1, "wo-24817-x", "ROSETTE_PHOTO", "ev-1"));
  }
  // What the activity of the guest writes later: a case (id is a ULID) and the account's own registry row.
  await world.connector.cases.createCase(openCase({ ispId: SIGNUP_ISP, clockId: SIGNUP_CLOCK, workOrderId: "wo-24818-gs261001abcde", installerId: "inst-rogelio-gs261001abcde" }));
  await world.connector.isps.putUser({ ispId: SIGNUP_ISP, userId: SIGNUP_USER, role: "GUEST", name: "Invitado", cognitoSub: "sub-1", guestOrigin: "SIGNUP", cognitoUsername: "gst-01K60000000000000000000001" });
  return world;
}

const rowsOf = (world: ReturnType<typeof worldHarness>, marker: string) => allRows(world).filter(({ row }) => JSON.stringify(row).includes(marker));

describe("[FL-107] [FL-111] generations of a guest world", () => {
  it("[FL-111] the destruction removes only the generation asked for: its items, its guest/ objects of every epoch", async () => {
    const world = await twoGenerationsAndAnInvitedWorld();
    const other = JSON.stringify(rowsOf(world, OTHER_ISP));
    const invited = JSON.stringify(rowsOf(world, "isp-guest-07"));
    expect(rowsOf(world, SIGNUP_ISP).length).toBeGreaterThan(300);

    const result = await destroyGeneration(world.destroyDeps(), SIGNUP_CLOCK);
    expect(result.items).toBeGreaterThan(300);
    expect(result.objects).toBe(2);

    // Left: the account's own registry row (GuestAccountDeletion removes it after Cognito) and the epoch counter.
    const left = rowsOf(world, SIGNUP_ISP).map(({ row }) => `${String(row.entity)}|${String(row.PK)}`);
    expect(left.sort()).toEqual([`ConsoleUser|ISP#${SIGNUP_ISP}`, `Counter|COUNTER#EPOCH#${SIGNUP_CLOCK}`]);
    expect(await world.connector.cases.getCase(openCase().caseId)).toBeUndefined();
    expect(JSON.stringify(rowsOf(world, OTHER_ISP))).toBe(other);
    expect(JSON.stringify(rowsOf(world, "isp-guest-07"))).toBe(invited);
    expect([...world.objects.keys.Media].length).toBe(2);
    expect([...world.objects.keys.Evidence].length).toBe(2);

    const again = await destroyGeneration(world.destroyDeps(), SIGNUP_CLOCK);
    expect(again).toMatchObject({ items: 0, objects: 0 });
  });

  it("[FL-118] the deletion's port destroys only a sign-up generation, never an invited or rehearsal world", async () => {
    const world = await twoGenerationsAndAnInvitedWorld();
    const destroyer = signupGenerationDestroyer(world.destroyDeps());
    await expect(destroyer.destroyGeneration({ clockId: "GUEST#isp-guest-07" })).rejects.toBeInstanceOf(ToolError);
    await expect(destroyer.destroyGeneration({ clockId: "GUEST#isp-guest-test" })).rejects.toBeInstanceOf(ToolError);
    await expect(destroyer.destroyGeneration({ clockId: "GLOBAL#isp-demo" })).rejects.toThrow();
    await destroyer.destroyGeneration({ clockId: OTHER_CLOCK });
    expect(rowsOf(world, OTHER_ISP).filter(({ row }) => row.entity !== "Counter")).toEqual([]);
  });

  it("[FL-107] random suffixes are 5 characters of [a-z2-7]", () => {
    const suffixes = Array.from({ length: 200 }, randomSuffix);
    for (const suffix of suffixes) expect(suffix).toMatch(/^[a-z2-7]{5}$/);
    expect(new Set(suffixes).size).toBeGreaterThan(190);
  });
});
