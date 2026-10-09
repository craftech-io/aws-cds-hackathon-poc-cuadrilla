import { describe, expect, it } from "vitest";
import { phoneticOf, respell, syllables } from "./phonetic";

describe("pronunciation help of the guest's kit [FL-101]", () => {
  it("[FL-101] splits Spanish words into syllables", () => {
    expect(syllables("conector")).toEqual(["co", "nec", "tor"]);
    expect(syllables("limpié")).toEqual(["lim", "pié"]);
    expect(syllables("roseta")).toEqual(["ro", "se", "ta"]);
    expect(syllables("cable")).toEqual(["ca", "ble"]);
    expect(syllables("señora")).toEqual(["se", "ño", "ra"]);
  });

  it("[FL-101] respells each syllable for an English reader", () => {
    expect(respell("que")).toBe("keh");
    expect(respell("ge")).toBe("heh");
    expect(respell("gue")).toBe("geh");
    expect(respell("jo")).toBe("hoh");
    expect(respell("ce")).toBe("seh");
    expect(respell("llo")).toBe("yoh");
    expect(respell("ño")).toBe("nyoh");
    expect(respell("pié")).toBe("pyeh");
    expect(respell("chis")).toBe("chis");
    expect(respell("ha")).toBe("ah");
  });

  it("[FL-101] marks the stressed syllable in capitals and keeps the punctuation", () => {
    expect(phoneticOf("Ya limpié el conector, ya prende.")).toBe("yah lim-PYEH el koh-nek-TOR, yah PREN-deh.");
    expect(phoneticOf("¿Se le cobra?")).toBe("¿seh leh KOH-brah?");
    expect(phoneticOf("ONU")).toBe("OH-noo");
  });
});
