// The operator's visible name in every world (ADR-0018, docs/test-plan.md §3 `worlds/brand.test.ts`): the
// factory writes `Isps/META.displayName` with `resolveBrand`, and a change of `BrandConfig` rewrites the
// name and renders the historical certificates again in the worlds that exist, without resetting them.
import { describe, expect, it } from "vitest";
import { DEMO_CLOCK_ID, DEMO_ISP_ID } from "@cuadrilla/shared";
import { DEFAULT_OPERATOR_NAME } from "../copy/brand";
import { brandFingerprint, rewriteBrand, worldDisplayName } from "./brand";
import { factoryDepsOf } from "./deps";
import { buildWorld } from "./factory";
import { COBRAND, NEUTRAL, SIGNUP_ISP, SIGNUP_USER, allRows, worldsHarness } from "./testing";
import { createWorld } from "./worlds";

describe("brand of the worlds", () => {
  it("the factory writes the name of resolveBrand in every world; a sign-up world follows signupMode", async () => {
    const harness = worldsHarness({ brand: COBRAND });
    await createWorld(harness.deps, { clockId: DEMO_CLOCK_ID });
    await buildWorld(factoryDepsOf(harness.deps), { ispId: "isp-guest-07", origin: "INVITED" });
    await buildWorld(factoryDepsOf(harness.deps), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    await createWorld(harness.deps, { clockId: "qa-2-sc-01", operations: [{ key: "a", model: "wo-24817", installer: "own" }] });
    await createWorld(harness.deps, { clockId: "eval-2", operations: [{ key: "a", model: "wo-24817", installer: "own" }] });
    const names = Object.fromEntries(
      await Promise.all([DEMO_ISP_ID, "isp-guest-07", SIGNUP_ISP, "isp-qa-2-sc-01", "isp-eval-2"].map(async (ispId) => [ispId, (await harness.connector.isps.getIsp(ispId))?.displayName])),
    );
    expect(names).toEqual({
      [DEMO_ISP_ID]: COBRAND.partnerDisplayName,
      "isp-guest-07": COBRAND.partnerDisplayName,
      [SIGNUP_ISP]: DEFAULT_OPERATOR_NAME,
      "isp-qa-2-sc-01": COBRAND.partnerDisplayName,
      "isp-eval-2": COBRAND.partnerDisplayName,
    });
    expect(worldDisplayName({ ...COBRAND, signupMode: "cobrand" }, `GUEST#${SIGNUP_ISP}`)).toBe(COBRAND.partnerDisplayName);
  });

  it("a change of BrandConfig rewrites the name and renders the historical certificates again, without a reset", async () => {
    const harness = worldsHarness({ brand: NEUTRAL });
    await createWorld(harness.deps, { clockId: DEMO_CLOCK_ID });
    await buildWorld({ ...factoryDepsOf(harness.deps), certificates: harness.deps.certificates }, { ispId: "isp-guest-07", origin: "INVITED" });
    const guestCertificates = allRows(harness).filter(({ table, row }) => table === "WorkOrders" && row.entity === "Certificate" && row.clockId === "GUEST#isp-guest-07");
    expect(guestCertificates.length).toBeGreaterThan(0);
    expect(guestCertificates.every(({ row }) => row.pdfPending === undefined)).toBe(true);
    const before = new Map([...harness.pdfs].map(([key, bytes]) => [key, Buffer.from(bytes).toString("base64")]));
    const epochBefore = (await harness.connector.runtime.getClock(DEMO_CLOCK_ID))?.worldEpoch;

    harness.setBrand(COBRAND);
    expect(brandFingerprint(COBRAND)).not.toBe(brandFingerprint(NEUTRAL));
    const rewritten = await rewriteBrand(harness.deps, [
      { clockId: DEMO_CLOCK_ID, ispId: DEMO_ISP_ID },
      { clockId: "GUEST#isp-guest-07", ispId: "isp-guest-07" },
    ]);
    expect(rewritten.map((world) => [world.ispId, world.renamed, world.certificates])).toEqual([
      [DEMO_ISP_ID, true, 12],
      ["isp-guest-07", true, guestCertificates.length],
    ]);
    expect((await harness.connector.isps.getIsp(DEMO_ISP_ID))?.displayName).toBe(COBRAND.partnerDisplayName);
    expect((await harness.connector.runtime.getClock(DEMO_CLOCK_ID))?.worldEpoch).toBe(epochBefore);
    const changed = [...harness.pdfs].filter(([key, bytes]) => before.get(key) !== Buffer.from(bytes).toString("base64"));
    expect(changed.length).toBe(before.size);
    // The same brand again: nothing to rename, nothing rendered.
    expect((await rewriteBrand(harness.deps, [{ clockId: DEMO_CLOCK_ID, ispId: DEMO_ISP_ID }])).map((world) => world.certificates)).toEqual([0]);
  });
});
