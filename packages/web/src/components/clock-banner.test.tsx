import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClockBanner } from "./ClockBanner";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => undefined;

describe("ClockBanner", () => {
  it("reads as one line: label, simulated time and mode, inside a named region", () => {
    const html = renderToStaticMarkup(createElement(ClockBanner, { label: "Hora simulada", time: "mar 13/10 09:20", mode: "reloj de demo en pausa" }));
    expect(html).toContain('aria-label="Hora simulada"');
    expect(text(html)).toContain("Hora simulada · mar 13/10 09:20 · reloj de demo en pausa");
    expect(html).not.toContain("animate-pulse");
  });

  it("shows the placeholder while there is no time, and pulses for a running clock", () => {
    expect(text(renderToStaticMarkup(createElement(ClockBanner, { label: "Hora simulada", placeholder: "Cargando…" })))).toContain("Cargando…");
    expect(renderToStaticMarkup(createElement(ClockBanner, { label: "Hora simulada", time: "mar 13/10 09:20", live: true }))).toContain("animate-pulse");
  });

  it("announces what the world waits for and disables the controls it is given disabled", () => {
    const html = renderToStaticMarkup(
      createElement(ClockBanner, {
        label: "Hora simulada",
        time: "mar 13/10 09:20",
        status: { tone: "busy", text: "Transcribiendo nota de voz (~15 s)" },
        actions: [
          { id: "next", label: "Avanzar al próximo evento", onClick: noop, disabled: true },
          { id: "advance-10", label: "+10 min", onClick: noop },
        ],
        actionsLabel: "Controles del reloj de demo",
      }),
    );
    expect(html).toMatch(/role="status" aria-live="polite"[^>]*>.*Transcribiendo nota de voz \(~15 s\)/);
    expect(html).toContain('role="group" aria-label="Controles del reloj de demo"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Avanzar al próximo evento<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>\+10 min<\/button>/);
  });
});
