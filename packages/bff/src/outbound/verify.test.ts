import { describe, expect, it } from "vitest";
import { claimsPolicy } from "./verify/claims";
import { collectSourceFacts, extractTextFacts, ungroundedFacts } from "./verify/facts";
import { containsWords, normalizeFacts, numberOf } from "./verify/normalize";
import { verifyContent } from "./verify/index";

const WORK_ORDER = {
  workOrderNumber: "24817",
  plan: "Fibra 300",
  onuSerial: "DEMO3F2C19A0",
  opticalClass: "B+",
  appointmentWindow: { startSim: "2026-10-13T09:00:00-06:00", endSim: "2026-10-13T11:00:00-06:00" },
  windowText: "hoy 09:00 a 11:00",
};
const ONU = { operState: "ONLINE", rxPowerDbm: -21.4, wavelengthNm: 1490 };
const MED_01 = { passages: [{ sectionId: "MED-01", text: "Clase B+: la potencia recibida aceptada va de −8 a −25 dBm; clase C+: de −8 a −28 dBm." }] };
const COM_04 = { passages: [{ sectionId: "COM-04", text: "Hasta 15 m de cable dentro del domicilio no tiene costo. Si pasa de 15 m se registra un cargo de extensión en la siguiente factura." }] };

describe("normalizeFacts: the single normalizer of the pipeline and the scenario oracles", () => {
  it("removes case and accents and makes minus signs and decimal commas canonical", () => {
    expect(normalizeFacts("Menos 21.4 dBm")).toBe(normalizeFacts("−21,4 dBm"));
    expect(normalizeFacts("-21,4 dBm")).toBe("−21,4 dbm");
    expect(normalizeFacts("¿Órdenes de HOY?")).toBe("ordenes de hoy");
    expect(numberOf("−21,4")).toBe(-21.4);
  });

  it("writes the spelled-out vocabulary of Transcribe as it displays it", () => {
    expect(containsWords("ya estoy con la señora, la o ene u no prende la luz pe-o-ene", ["ONU", "PON"])).toBe(true);
    expect(normalizeFacts("catorce noventa")).toBe("1490");
    expect(containsWords("la ONT está bien", ["ONU"])).toBe(false);
  });
});

describe("facts of a text and of the turn's tool results", () => {
  it("reads power figures, serials, order numbers, times and amounts", () => {
    const facts = extractTextFacts("La 24817 (DEMO3F2C19A0) está en −21,4 dBm; tu cita es de 09:00 a 11:00 y no cobras $150.");
    expect(facts.numbers).toEqual(expect.arrayContaining([24817, 21.4, 150]));
    expect(facts.codes).toEqual(["demo3f2c19a0"]);
    expect(facts.times).toEqual(["09:00", "11:00"]);
  });

  it("grounds the same fact written in another form ('menos 21.4' = rxPowerDbm -21.4)", () => {
    const sources = collectSourceFacts([WORK_ORDER, ONU]);
    expect(ungroundedFacts("Tu ONU marca menos 21.4 dBm a 1490 nm, la orden 24817 de 09:00 a 11:00.", sources)).toEqual([]);
  });

  it("[FL-033] names the invented figure, never the text", () => {
    const sources = collectSourceFacts([WORK_ORDER, COM_04]);
    expect(ungroundedFacts("El cambio de roseta cuesta $150.", sources)).toEqual(["number 150"]);
    expect(ungroundedFacts("El serial es ABCD1234EF.", sources)).toEqual(["code"]);
  });
});

describe("claims of policy or procedure (CP-CITATION)", () => {
  it("flags money, limits, permissions and technical steps", () => {
    expect(claimsPolicy("Hasta 15 m de cable no tiene costo (Manual v1, §COM-04).")).toBe(true);
    expect(claimsPolicy("El mínimo en B+ es −25 dBm.")).toBe(true);
    expect(claimsPolicy("Limpia el conector SC/APC con el limpiador de un clic.")).toBe(true);
    expect(claimsPolicy("No está permitido dejar la contraseña.")).toBe(true);
  });

  it("does not flag a request for photos, a greeting or a status line", () => {
    expect(claimsPolicy("Listo. Para cerrar mándame 3 fotos: la lectura del medidor, la etiqueta de la ONU y la roseta.")).toBe(false);
    expect(claimsPolicy("Hola Rogelio, tu orden 24817 sigue en curso.")).toBe(false);
  });
});

describe("verifyContent", () => {
  it("[FL-029] a procedure answer citing a section of the turn with its figure passes", () => {
    const failures = verifyContent({
      textSource: "MODEL",
      text: "En B+ lo mínimo para cerrar es −25 dBm (Manual v1, §MED-01).",
      sources: [WORK_ORDER, MED_01],
      citation: { cited: ["MED-01"], turnSections: ["MED-01"] },
    });
    expect(failures).toEqual([]);
  });

  it("[FL-029] a figure that is not in the turn's passage fails FACTS", () => {
    const failures = verifyContent({ textSource: "MODEL", text: "En B+ lo mínimo para cerrar es −27 dBm (Manual v1, §MED-01).", sources: [WORK_ORDER, MED_01], citation: { cited: ["MED-01"], turnSections: ["MED-01"] } });
    expect(failures.map((failure) => failure.check)).toEqual(["FACTS"]);
    expect(failures[0]?.detail).toContain("number 27");
  });

  it("[FL-033] a policy statement without a citation, or citing a section the turn did not return, fails CITATION", () => {
    const uncited = verifyContent({ textSource: "MODEL", text: "Hasta 15 m de cable no tiene costo.", sources: [COM_04], citation: { cited: [], turnSections: ["COM-04"] } });
    expect(uncited.map((failure) => failure.check)).toEqual(["CITATION"]);
    const foreign = verifyContent({ textSource: "MODEL", text: "Hasta 15 m de cable no tiene costo (Manual v1, §COM-02).", sources: [COM_04], citation: { cited: [], turnSections: ["COM-04"] } });
    expect(foreign.map((failure) => failure.check)).toEqual(["CITATION"]);
    expect(foreign[0]?.detail).toContain("COM-02");
  });

  it("refuses sensitive asks and foreign links of any author, and English from the model", () => {
    expect(verifyContent({ textSource: "MODEL", text: "Pásame el CURP de la señora para registrarla.", sources: [] }).map((failure) => failure.check)).toContain("SENSITIVE");
    expect(verifyContent({ textSource: "CODE", text: "Revisa www.ejemplo-falso.mx para el detalle.", sources: [] }).map((failure) => failure.check)).toContain("LINKS");
    expect(verifyContent({ textSource: "MODEL", text: "Please send the photo of the meter now.", sources: [] }).map((failure) => failure.check)).toContain("LANGUAGE");
    expect(verifyContent({ textSource: "PERSON", text: "Pásame el CURP", sources: [] })).toEqual([]);
  });

  it("checks every template parameter for links and asks; a fixed text is not fact-checked", () => {
    const failures = verifyContent({ textSource: "CODE", templateParams: ["Rogelio", "visita wa.me/5255"], sources: [] });
    expect(failures).toEqual([{ check: "LINKS", detail: "template parameter 2" }]);
    expect(verifyContent({ textSource: "CODE", text: "Escalé tu caso a Adriana (supervisión de turno). Te aviso en cuanto lo tome.", sources: [] })).toEqual([]);
  });
});
