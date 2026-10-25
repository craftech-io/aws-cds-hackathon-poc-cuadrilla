import { describe, expect, it } from "vitest";
import { itemNamedBy, photoItemDecision } from "./photo-item";

const checklist = (statuses: Record<string, string>) => ({
  listChecklist: async () => Object.entries(statuses).map(([item, status]) => ({ item, status })) as never,
});

describe("the item of a photo, by code (FL-046, FL-039)", () => {
  it("[FL-046] reads an item from a caption that is its button title, in es or en, and nothing else", () => {
    expect(itemNamedBy("Etiqueta de la ONU")).toBe("ONU_LABEL_PHOTO");
    expect(itemNamedBy("  lectura del MEDIDOR. ")).toBe("POWER_READING_PHOTO");
    expect(itemNamedBy("Installed rosette")).toBe("ROSETTE_PHOTO");
    expect(itemNamedBy("creo que es la etiqueta")).toBeUndefined();
    expect(itemNamedBy("")).toBeUndefined();
  });

  it("[FL-046] one photo item pending is the item; several are asked; none goes to the agent", async () => {
    expect(await photoItemDecision(checklist({ ONU_ONLINE: "PASSED", POWER_READING_PHOTO: "PASSED", ONU_LABEL_PHOTO: "REJECTED", ROSETTE_PHOTO: "OVERRIDDEN" }), "wo-1")).toEqual({ kind: "KNOWN", item: "ONU_LABEL_PHOTO" });
    expect(await photoItemDecision(checklist({ POWER_READING_PHOTO: "PENDING", ONU_LABEL_PHOTO: "IN_REVIEW", ROSETTE_PHOTO: "PASSED", CUSTOMER_OK: "PENDING" }), "wo-1")).toEqual({ kind: "ASK", items: ["POWER_READING_PHOTO", "ONU_LABEL_PHOTO"] });
    expect(await photoItemDecision(checklist({ POWER_READING_PHOTO: "PASSED", ONU_LABEL_PHOTO: "PASSED", ROSETTE_PHOTO: "PASSED" }), "wo-1")).toEqual({ kind: "AGENT" });
  });
});
