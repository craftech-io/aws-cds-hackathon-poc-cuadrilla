import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MODES_FILE, PENDING_FILE, checkModes, checkOverridesExample, checkWorldTemplates, isClosed, pendingStatus, readModes } from "./check-modes";

const modesSource = (transports: string, email = "live") => `
export const channelModes = {
  email: "${email}",
  whatsapp: { transports: [${transports}] }, // add "live" only after docs/pending.md P-01 is closed
} as const satisfies ChannelModesConfig;
`;

const pending = (p01: string) => `
| # | Pendiente | Dueño | Estado | Qué falta |
|---|---|---|---|---|
| P-01 | Conectar WhatsApp | CTO (Meta) | ${p01} | §1 |
| P-02 | Oportunidad ACE | CTO | Abierto | §2 |
`;

const OPEN = "Abierto · opción A decidida";
const CLOSED = "Cerrado el 2026-10-10 por el CTO";
const SIMULATED = '"simulated"';
const BOTH = '"simulated", "live"';

describe("readModes", () => {
  it("reads email and the WhatsApp transports as plain literals", () => {
    expect(readModes(modesSource(SIMULATED))).toEqual({ email: "live", transports: ["simulated"] });
    expect(readModes(modesSource(BOTH))).toEqual({ email: "live", transports: ["simulated", "live"] });
  });

  it("ignores transports that are not a plain literal list on their own line", () => {
    expect(readModes(`whatsapp: { transports: process.env.WA },`)).toEqual({});
  });
});

describe("pendingStatus and isClosed", () => {
  it("returns the Estado cell of the row with that id", () => {
    expect(pendingStatus(pending(OPEN), "P-01")).toBe(OPEN);
    expect(pendingStatus(pending(OPEN), "P-99")).toBeUndefined();
  });

  it("accepts only the closure format of docs/pending.md", () => {
    expect(isClosed(CLOSED)).toBe(true);
    expect(isClosed("Cerrada el 2026-10-10 por devops con el CTO")).toBe(true);
    for (const open of ["Abierto", "Abierto · Cerrado el 2026-10-10 por nadie", "Cerrado", "Cerrado pronto"]) expect(isClosed(open), open).toBe(false);
  });
});

describe("checkModes [FL-100]", () => {
  it("passes while WhatsApp only has the simulated transport", () => {
    expect(checkModes(modesSource(SIMULATED), pending(OPEN))).toEqual([]);
  });

  it("fails when the live transport is declared and P-01 is open", () => {
    const errors = checkModes(modesSource(BOTH), pending(OPEN));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"live" is a WhatsApp transport');
    expect(errors[0]).toContain("P-01");
  });

  it("passes when the live transport is declared and P-01 was closed", () => {
    expect(checkModes(modesSource(BOTH), pending(CLOSED))).toEqual([]);
  });

  it("keeps the simulated transport, rejects unknown ones and requires email live", () => {
    expect(checkModes(modesSource('"live"'), pending(CLOSED))[0]).toContain('"simulated" transport must stay');
    expect(checkModes(modesSource('"simulated", "sms"'), pending(OPEN))[0]).toContain('unknown WhatsApp transport(s) "sms"');
    expect(checkModes(modesSource(SIMULATED, "simulated"), pending(OPEN))[0]).toContain('email must be "live"');
    expect(checkModes(`email: "live",\n`, pending(OPEN))[0]).toContain("transports: [...]");
    expect(checkModes(modesSource(BOTH), "| # | Pendiente |\n|---|---|\n")[0]).toContain("has no row for P-01");
  });
});

describe("world templates and overrides example [FL-100]", () => {
  it("fails a world template that is not simulated, wherever the field is", () => {
    expect(checkWorldTemplates([["demo.json", JSON.stringify({ isp: { settings: { whatsappMode: "simulated" } } })]])).toEqual([]);
    const errors = checkWorldTemplates([["judge.json", JSON.stringify({ isps: [{ settings: { whatsappMode: "live" } }] })]]);
    expect(errors).toEqual(['judge.json: $.isps[0].settings.whatsappMode must be "simulated"; a world goes live only through SeedOverrides.liveWorldClockId.']);
    expect(checkWorldTemplates([["broken.json", "{"]])).toEqual(["broken.json: not valid JSON."]);
  });

  it("accepts at most one live world in the overrides example", () => {
    expect(checkOverridesExample(JSON.stringify({ liveWorldClockId: null }))).toEqual([]);
    expect(checkOverridesExample(JSON.stringify({ liveWorldClockId: "GLOBAL#isp-demo" }))).toEqual([]);
    expect(checkOverridesExample(JSON.stringify({ liveWorldClockId: ["GLOBAL#isp-demo", "GLOBAL#isp-other"] }))[0]).toContain("found 2");
  });
});

describe("repository state", () => {
  it("the committed modes and pending list pass the check", () => {
    const root = resolve(__dirname, "../..");
    const modes = readFileSync(resolve(root, MODES_FILE), "utf8");
    const pendingMarkdown = readFileSync(resolve(root, PENDING_FILE), "utf8");
    expect(checkModes(modes, pendingMarkdown)).toEqual([]);
    expect(readModes(modes)).toEqual({ email: "live", transports: ["simulated"] });
  });
});
