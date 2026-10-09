import { describe, expect, it } from "vitest";
import { blocksOf, groupedSections, inlinesOf, selectedSection } from "./manual-model";

const COM_04 = `# COM-04 · Reubicación de la roseta

_Manual v1 · demo sintética: procedimientos generales y políticas comerciales inventadas._

Si el cliente quiere la roseta en otro lugar
dentro del domicilio:

- Hasta 15 m de cable interior, sin costo.
- Si se necesitan más de 15 m, cargo en la siguiente factura (§COM-02).

## Notas

La nueva ubicación cumple §INS-04.`;

describe("manual viewer model [FL-028] [FL-090]", () => {
  it("reads a section's Markdown as blocks without its title, with emphasis and section links, and never as HTML", () => {
    const blocks = blocksOf(COM_04);
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "paragraph", "list", "heading", "paragraph"]);
    expect(blocks[0]).toEqual({ kind: "paragraph", inlines: [{ kind: "em", text: "Manual v1 · demo sintética: procedimientos generales y políticas comerciales inventadas." }] });
    expect(blocks[1]).toEqual({ kind: "paragraph", inlines: [{ kind: "text", text: "Si el cliente quiere la roseta en otro lugar dentro del domicilio:" }] });
    expect(blocks[2]).toMatchObject({ kind: "list", items: [[{ kind: "text" }], [{ kind: "text" }, { kind: "ref", sectionId: "COM-02" }, { kind: "text", text: ")." }]] });
    expect(blocks[4]).toEqual({ kind: "paragraph", inlines: [{ kind: "text", text: "La nueva ubicación cumple " }, { kind: "ref", sectionId: "INS-04" }, { kind: "text", text: "." }] });
    expect(inlinesOf("<b>no</b>")).toEqual([{ kind: "text", text: "<b>no</b>" }]);
  });

  it("groups the sections by category in the manual's order and finds the one a citation opens", () => {
    const sections = [
      { sectionId: "SEG-01", title: "Riesgo eléctrico", category: "SEG" },
      { sectionId: "COM-04", title: "Reubicación de la roseta", category: "COM" },
      { sectionId: "DIAG-02", title: "Sin luz PON", category: "DIAG" },
    ] as never[];
    expect(groupedSections(sections).map((group) => group.title)).toEqual(["Diagnóstico", "Políticas comerciales", "Seguridad"]);
    expect(selectedSection(sections, "COM-04")).toMatchObject({ sectionId: "COM-04" });
    expect(selectedSection(sections, "XYZ-99")).toBeUndefined();
    expect(selectedSection(sections, undefined)).toBeUndefined();
  });
});
