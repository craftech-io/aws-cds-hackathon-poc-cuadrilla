import { describe, expect, it } from "vitest";
import { tableEvalRuns } from "../metrics/eval-runs";
import { scorePhotos } from "../metrics/eval-score";
import { MAX_PHOTOS_PER_CALL } from "./ports";
import { runPhotos } from "./run-photos";
import { evalHarness } from "./testing";

async function photoIds(deps: Awaited<ReturnType<typeof evalHarness>>["deps"]): Promise<string[]> {
  return (await deps.connector.reference.listEvalPhotos()).map((photo) => photo.photoId).sort();
}

describe("eval.runPhotos over a measurement world, with the scripted validator [FL-036] [FL-037] [FL-038] [FL-039] [FL-040] [FL-041] [FL-043] [FL-097] [FL-087]", () => {
  it("[FL-036] runs the 60 photos in batches through validate_install_photo, scores them and publishes the run", async () => {
    const { harness, deps, clockId, modelCalls } = await evalHarness("P");
    const ids = await photoIds(deps);
    expect(ids).toHaveLength(60);
    const batches = Array.from({ length: Math.ceil(ids.length / MAX_PHOTOS_PER_CALL) }, (_, index) => ids.slice(index * MAX_PHOTOS_PER_CALL, (index + 1) * MAX_PHOTOS_PER_CALL));
    for (const [index, batch] of batches.entries()) {
      const out = await runPhotos(deps, { clockId, photoIds: batch, publish: index === batches.length - 1 });
      expect(out.ran.map((entry) => entry.result.itemId)).toEqual(batch);
      if (index < batches.length - 1) continue;
      expect(out.publish).toMatchObject({ published: true, missing: [] });
      expect(out.publish?.results).toHaveLength(60);
    }
    const rows = await deps.connector.metrics.listEvalResults("isp-eval-local-1-p", "local-1-p", "P");
    expect(rows).toHaveLength(60);
    expect(rows.filter((row) => row.outcome.startsWith("ERROR")).map((row) => `${row.itemId} ${String(row.details.error)}`)).toEqual([]);
    const score = scorePhotos(rows, await deps.connector.reference.listEvalPhotos());
    expect(score.accuracy).toEqual({ value: 1, numerator: 60, denominator: 60 });
    expect(score.passRecall).toEqual({ value: 1, numerator: 21, denominator: 21 });
    expect(score.outOfRangeAccepted).toBe(0);
    expect(score.adversarialAccepted).toBe(0);
    // The duplicate never reached the model; every other photo did.
    expect(modelCalls()).toBe(59);
    expect(await tableEvalRuns(harness.client).latest("P")).toEqual({ ispId: "isp-eval-local-1-p", runId: "local-1-p", finishedAtReal: harness.now().toISOString() });
  }, 60_000);

  it("[FL-097] the adversarial duplicate is rejected by the seeded PASS evidence, whatever ran before it", async () => {
    const { deps, clockId, modelCalls } = await evalHarness("P");
    const out = await runPhotos(deps, { clockId, photoIds: ["ph-adv-04", "ph-meter-01"] });
    const [duplicate, original] = out.ran.map((entry) => entry.result);
    expect(duplicate).toMatchObject({ itemId: "ph-adv-04", outcome: "REJECT", passed: true, details: { reasonCode: "DUPLICATE_EVIDENCE", reasonCorrect: true, duplicates: "ph-meter-01" } });
    expect(original).toMatchObject({ itemId: "ph-meter-01", outcome: "PASS", passed: true });
    expect(modelCalls()).toBe(1);
  }, 30_000);

  it("[FL-037] each photo is read against its label's orchestrator value, on an order of its class and serial", async () => {
    const { harness, deps, clockId } = await evalHarness("P");
    // The meter that disagrees with the orchestrator and an in-range meter of the same model, in that order.
    const out = await runPhotos(deps, { clockId, photoIds: ["ph-meter-05", "ph-adv-02", "ph-meter-01"] });
    expect(out.ran.map((entry) => [entry.result.itemId, entry.result.outcome, entry.result.details.reasonCode])).toEqual([
      ["ph-meter-05", "REJECT", "READING_MISMATCH"],
      ["ph-adv-02", "REJECT", "OUT_OF_RANGE_LOW"],
      ["ph-meter-01", "PASS", undefined],
    ]);
    const orders = out.ran.map((entry) => entry.result.details.workOrderId);
    expect(new Set(orders).size).toBe(3);
    // A validation by tool.invoke with a QA caller never marks the item PASSED (ph-meter-01's order was seeded PASSED).
    for (const workOrderId of orders.slice(0, 2)) expect((await harness.connector.workOrders.getChecklistItem(String(workOrderId), "POWER_READING_PHOTO"))?.status).toBe("REJECTED");
  }, 30_000);

  it("[FL-087] a photo already measured is skipped, a rerun replaces it, and an incomplete run is not published", async () => {
    const { harness, deps, clockId } = await evalHarness("P");
    await runPhotos(deps, { clockId, photoIds: ["ph-label-01"] });
    const again = await runPhotos(deps, { clockId, photoIds: ["ph-label-01", "ph-label-02"], publish: true });
    expect(again.skipped).toEqual(["ph-label-01"]);
    expect(again.ran.map((entry) => entry.result.itemId)).toEqual(["ph-label-02"]);
    expect(again.publish?.published).toBe(false);
    expect(again.publish?.missing).toHaveLength(58);
    expect(await tableEvalRuns(harness.client).latest("P")).toBeUndefined();
    const rerun = await runPhotos(deps, { clockId, photoIds: ["ph-label-01"], rerun: true });
    expect(rerun.ran).toHaveLength(1);
  }, 30_000);

  it("refuses a photo outside the set and a world that is not an evaluation one", async () => {
    const { deps, clockId } = await evalHarness("P");
    await expect(runPhotos(deps, { clockId, photoIds: ["ph-hist-01"] })).rejects.toMatchObject({ code: "INVALID", reason: "EVAL_UNKNOWN_ITEM" });
    await expect(runPhotos(deps, { clockId: "qa-812-1-sc-04", photoIds: ["ph-meter-01"] })).rejects.toThrow();
  }, 30_000);
});
