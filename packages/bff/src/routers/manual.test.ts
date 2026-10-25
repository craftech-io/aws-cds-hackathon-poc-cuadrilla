import { TRPCError } from "@trpc/server";
import { ChannelError } from "@cuadrilla/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createCallerFactory, createContextFactory } from "./trpc";
import { DEMO } from "../services/people/testing";
import { resetBrandLinks } from "./brand";
import { type ConsoleTestWorld, consoleTestWorld } from "./console-testing";
import { appRouter } from "./index";

async function loadManual(t: ConsoleTestWorld): Promise<void> {
  const { reference } = t.memory.connector;
  await reference.put("ManualIndex", { manualVersion: "v001", sectionId: "COM-04", title: "Roseta en otro cuarto", category: "COM" });
  await reference.put("ManualIndex", { manualVersion: "v001", sectionId: "DIAG-02", title: "Sin luz PON", category: "DIAG" });
  t.ports.objects.put("Manual", "manual/v001/COM-04.md", new TextEncoder().encode("# COM-04\nHasta 15 m de cable interior sin cargo."), "text/markdown");
}

describe("manual router [FL-090]", () => {
  it("[FL-090] lists the sections of the manual in force by id, and the cited section opens", async () => {
    const t = await consoleTestWorld(DEMO);
    await loadManual(t);
    const console = await t.as("OPS", "usr-ops");
    const manual = await console.manual.sections();
    expect(manual).toMatchObject({ manualVersion: "v001", label: "v1", sections: [{ sectionId: "COM-04" }, { sectionId: "DIAG-02" }] });
    expect(manual.operator).toMatchObject({ mode: "neutral", disclaimer: null });
    expect(await console.manual.section({ sectionId: "COM-04" })).toMatchObject({ sectionId: "COM-04", title: "Roseta en otro cuarto", text: expect.stringContaining("15 m") });
  });

  it("[FL-090] a section the manual does not have, or whose text is not loaded, is not found", async () => {
    const t = await consoleTestWorld(DEMO);
    await loadManual(t);
    const console = await t.as();
    for (const sectionId of ["GEN-99", "DIAG-02"]) {
      const error = await console.manual.section({ sectionId }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect((error as TRPCError).code).toBe("NOT_FOUND");
    }
  });
});

describe("brand.get (public, ADR-0018)", () => {
  beforeEach(() => resetBrandLinks());

  it("neutral: the fictitious operator, no logos and no disclaimer, without a principal", async () => {
    const t = await consoleTestWorld(DEMO);
    const anonymous = createCallerFactory(appRouter)(await createContextFactory(() => t.deps)({ event: { headers: {} } }));
    expect(await anonymous.brand.get()).toMatchObject({ mode: "neutral", logos: { onLight: null, onDark: null }, disclaimer: null });
  });

  it("co-branding: the partner's name always with the disclaimer; a logo only when its object exists, as a presigned link", async () => {
    const t = await consoleTestWorld(DEMO);
    t.ports.brandConfig = {
      mode: "cobrand",
      partnerDisplayName: "Socio de Diseño",
      partnerShortName: "Socio",
      logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" },
      disclaimer: { es: "Demo sintética.", en: "Synthetic demo." },
    };
    t.ports.objects.put("Seed", "brand/logo-on-light.svg", new TextEncoder().encode("<svg/>"), "image/svg+xml");
    const anonymous = createCallerFactory(appRouter)(await createContextFactory(() => t.deps)({ event: { headers: {} } }));
    const brand = await anonymous.brand.get();
    expect(brand.mode).toBe("cobrand");
    expect(brand.disclaimer?.es).toContain("Socio de Diseño");
    expect(brand.logos.onLight).toContain("/s3/Seed/brand/logo-on-light.svg");
    expect(brand.logos.onDark).toBeNull();
  });

  it("[FL-090] co-branding with logos that cannot be read (HeadObject 403): the wordmark, and the manual still opens", async () => {
    const t = await consoleTestWorld(DEMO);
    await loadManual(t);
    t.ports.brandConfig = {
      mode: "cobrand",
      partnerDisplayName: "Socio de Diseño",
      partnerShortName: "Socio",
      logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" },
      disclaimer: { es: "Demo sintética.", en: "Synthetic demo." },
    };
    Object.assign(t.ports.objects, { exists: () => Promise.reject(new ChannelError("UNAVAILABLE", "WHATSAPP", "HeadObject failed: Unknown", { retryable: true })) });
    const anonymous = createCallerFactory(appRouter)(await createContextFactory(() => t.deps)({ event: { headers: {} } }));
    expect(await anonymous.brand.get()).toMatchObject({ mode: "cobrand", logos: { onLight: null, onDark: null }, disclaimer: { es: expect.stringContaining("Socio de Diseño") } });
    const manual = await (await t.as("OPS", "usr-ops")).manual.sections();
    expect(manual.operator).toMatchObject({ mode: "cobrand", disclaimer: { es: expect.stringContaining("Socio de Diseño") } });
    expect(manual.sections.map((section) => section.sectionId)).toEqual(["COM-04", "DIAG-02"]);
  });
});
