import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkScope } from "../context/IspContext";
import { ScopeBar } from "./ScopeBar";

function render(value: WorkScope) {
  return renderToStaticMarkup(
    createElement(ScopeBar, {
      label: "Alcance",
      crews: { label: "Equipo de campo", allLabel: "Todos los equipos", options: [{ value: "crew-n3", label: "Norte 3" }] },
      days: { label: "Día", options: [{ value: "2026-10-13", label: "mar 13/10 (hoy)" }, { value: "2026-10-14", label: "mié 14/10" }] },
      value,
      onChange: () => undefined,
    }),
  );
}

describe("ScopeBar", () => {
  it("offers every crew first and the world's day by default", () => {
    const html = render({});
    expect(html).toContain('role="group" aria-label="Alcance"');
    expect(html).toMatch(/<option value="" selected="">Todos los equipos<\/option>/);
    expect(html).toMatch(/<option value="2026-10-13" selected="">mar 13\/10 \(hoy\)<\/option>/);
  });

  it("shows the crew and the day of the scope", () => {
    const html = render({ crewId: "crew-n3", day: "2026-10-14" });
    expect(html).toMatch(/<option value="crew-n3" selected="">Norte 3<\/option>/);
    expect(html).toMatch(/<option value="2026-10-14" selected="">mié 14\/10<\/option>/);
  });
});
