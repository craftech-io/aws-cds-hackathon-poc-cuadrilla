// The local Knowledge Base (tests/flows/support/aws.ts `knowledgeFake`): what it retrieves has to stay close
// to what the deployed embeddings retrieve, or the agent scenarios measure the fake instead of the agent.
import { describe, expect, it } from "vitest";
import { DEFAULT_KB_THRESHOLD } from "../../../packages/bff/src/knowledge/catalog";
import { knowledgeFake, singularOf } from "./aws";

/** The sections `search_procedures` would keep: the fake's results over the threshold in force. */
async function sectionsFor(query: string, category?: string): Promise<string[]> {
  const filter = category === undefined ? undefined : { andAll: [{ equals: { key: "category", value: category } }, { equals: { key: "manualVersion", value: "v001" } }] };
  const out = await knowledgeFake().send({ knowledgeBaseId: "local", retrievalQuery: { text: query }, ...(filter === undefined ? {} : { retrievalConfiguration: { vectorSearchConfiguration: { filter: filter as never } } }) });
  return (out.retrievalResults ?? []).filter((result) => (result.score ?? 0) >= DEFAULT_KB_THRESHOLD).map((result) => String((result.metadata as Record<string, unknown> | undefined)?.sectionId));
}

describe("local Knowledge Base", () => {
  it("reads a plural and its singular as one word, and nothing else as the same word", () => {
    expect(["mueble", "muebles", "conector", "conectores", "poste", "postes", "empalme", "empalmes"].map(singularOf)).toEqual(["muebl", "muebl", "conector", "conector", "post", "post", "empalm", "empalm"]);
    expect(singularOf("sobra")).not.toBe(singularOf("sobre"));
    expect(singularOf("tres")).toBe("tres");
  });

  it("finds §INS-06 for the ONU inside a TV cabinet, written \"muebles\" in the manual (EV-01 q-A-40)", async () => {
    expect((await sectionsFor("¿Se puede instalar la ONU dentro de un mueble de la tele? Ubicación y ventilación de la ONU", "INS"))[0]).toBe("INS-06");
  });

  it("finds §ESC-01 for when to escalate, written \"casos\" in the question and \"caso\" in the manual", async () => {
    expect((await sectionsFor("cuándo escalar al supervisor, casos de escalación", "ESC"))[0]).toBe("ESC-01");
  });
});
