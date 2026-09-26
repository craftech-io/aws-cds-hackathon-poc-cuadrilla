// Web searches recorded for the names of `Reference/NAMECHECK` (docs/seed-spec.md §12), keyed by the
// exact term they checked: the query as it was run, the date and what was found. A term renamed in the
// seed loses its searches here and `seed:validate` lists it as pending until the new name is searched
// and recorded; a key that matches no term of the seed fails the validation. Findings name no company,
// brand or equipment model: a collision is described, never spelled out.

export interface RecordedSearch {
  readonly query: string;
  readonly date: string;
  readonly finding: string;
  /** Where the search was recorded. */
  readonly recordedIn: string;
}

const SEARCHED_ON = "2026-09-26";
const RECORDED_IN = "scripts/seed/generate/namecheck-searches.ts";

function searched(query: string, finding: string): RecordedSearch {
  return { query, date: SEARCHED_ON, finding, recordedIn: RECORDED_IN };
}

/** Why no ISP or brand collides with a neighborhood name: the same two searches for each one. */
function neighborhood(term: string, toponym: string, telecomQuery: string): RecordedSearch[] {
  return [
    searched(
      `"${term}" colonia México`,
      `Common toponym (${toponym}) of colonias in several Mexican states; the seed uses it only inside the fictitious city, without postal code, so it points to no real address`,
    ),
    searched(telecomQuery, "No ISP, telecom brand or product of that name"),
  ];
}

const PLAN_TIERS_QUERY = searched(
  '"fibra200" OR "fibra300" OR "fibra500" empresa internet sitio',
  "No company, brand or site named after these plan names",
);

const PLAN_OWNERS_QUERY = searched(
  '"Fibra 300" OR "Fibra 500" nombre de empresa proveedor internet Brasil México',
  "No ISP named Fibra 300 or Fibra 500 in Brazil or Mexico; both appear only as speed tiers in the plans of several unrelated operators",
);

/**
 * The phone blocks against Mexico's published numbering plan: its structure (ITU communication of the
 * IFT and the plan of 1996 it replaced) and the blocks the IFT has assigned in zone 55.
 */
function phoneBlock(range: string): RecordedSearch[] {
  return [
    searched(
      "Plan Técnico Fundamental de Numeración IFT número local primer dígito no podrá ser 0",
      "The plan of 1996 excluded local numbers starting with 0 (c ≠ 0 in the 8-digit local numbers of Mexico City); the plan in force since 3 August 2019 (DOF 11/05/2018) replaced local numbers with 10-digit national numbers",
    ),
    searched(
      "ITU national numbering plan Mexico +52 communication T0202 pdf",
      "ITU communication of Mexico of 5.VII.2024: national numbers A b c d e f g h i j with A = 2-9, b = 1-9 and c-j = 0-9, so 55 0… is well formed today; the block is safe because no provider holds it (next check), not because of its shape",
    ),
    searched(
      `IFT Plan Nacional de Numeración, publication of 05/09/2026: geographic blocks overlapping ${range}`,
      "None. Of 178,172 geographic blocks, 13,460 are in zone 55 and the lowest starts at 55 1000 0000: no provider holds any number in 55 0000 0000-55 0999 9999. Read from a public normalized copy of that publication (the SNS portal serves the file only through its download form)",
    ),
    searched(
      "IFT numbering plan snapshot of 2022-06-12: series of NIR 55",
      "8,314 series in NIR 55, the lowest 1000 (55 1000 xxxx): no series starting with 0 then either",
    ),
  ];
}

export const RECORDED_SEARCHES: Readonly<Record<string, readonly RecordedSearch[]>> = {
  DEMO: [
    searched(
      "GPON ONU serial number vendor ID list 4 letters",
      "A GPON serial is a 4-character vendor id plus 8 hex digits; the public list of known ONU vendor ids has no DEMO",
    ),
    searched('"DEMO" GPON vendor id ONU serial', "No manufacturer or operator uses DEMO as a vendor id; only generic explanations of the serial format"),
  ],
  "ONU-G1": [
    searched('"ONU-G1" GPON', "No ONU or ONT model of that name; only generic 1-port GPON ONUs sold under other model names"),
    searched('"ONU-G1" router fibra óptica modelo', "No product of that name in Spanish-language catalogues or stores"),
    searched('"ONU G1" fiber optic terminal model manufacturer', "No manufacturer lists a model named ONU G1"),
    searched('"ONU-G1"', "Only unrelated uses of G1 and of ONU (United Nations in Spanish); no equipment"),
    searched(
      'ITU-T G.988 "ONU-G" managed entity OMCI',
      "ONU-G is a managed entity of the ITU-T OMCI recommendation, a standard term and not a product: the synthetic model reads as generic",
    ),
  ],
  OPM: [
    searched(
      '"OPM" optical power meter model fiber',
      "OPM is the generic abbreviation of optical power meter; several manufacturers use it as the prefix of numbered models and none sells a model named just OPM",
    ),
    searched('"OPM" medidor de potencia óptica marca modelo', "Same in Spanish-language catalogues: OPM names the category, every model carries a number or a brand"),
  ],
  "Ciudad Esmeralda": [
    searched('"Ciudad Esmeralda" México', "No Mexican city, municipality or locality of that name; only the title of a 2016 concert, a coastline and neighbourhoods named Esmeralda"),
    searched('"Ciudad Esmeralda" internet fibra óptica', "No ISP or telecom brand of that name; only ISPs of Brazilian places named Esmeralda or Esmeraldas"),
    searched('"Ciudad Esmeralda" fraccionamiento OR colonia OR municipio', "Only subdivisions named Esmeralda in several states; none called Ciudad Esmeralda"),
    searched(
      '"la Ciudad Esmeralda" apodo ciudad Colombia Ecuador Seattle',
      "A nickname of a US city and the title of press columns; the Ecuadorian city is Esmeraldas. No city is officially called Ciudad Esmeralda, and the console labels it fictitious",
    ),
  ],
  "Las Lomitas": neighborhood("Las Lomitas", "'little hills'", '"Las Lomitas" internet proveedor fibra telecom'),
  Arboledas: [
    searched('"Arboledas" colonia México internet fibra', "Common toponym ('groves') of colonias in several Mexican states; used only inside the fictitious city, without postal code"),
    searched('"Arboledas" OR "Arboledas Telecom" proveedor internet ISP', "No ISP or telecom brand of that name; also the name of municipalities in Colombia and Argentina, unrelated to the demo"),
  ],
  "El Mirador": [
    searched('"El Mirador" colonia México código postal', "Common toponym ('lookout') of colonias in many municipalities; used only inside the fictitious city, without postal code"),
    searched('"El Mirador" internet ISP telecom fibra México', "No ISP or telecom brand of that name"),
  ],
  "Los Encinos": neighborhood("Los Encinos", "'the oaks'", '"Los Encinos" internet ISP telecom fibra'),
  "Valle Sereno": [
    searched(
      '"Valle Sereno" México colonia',
      "No Mexican colonia of that name. It replaces the earlier name of this neighborhood, which carried the brand of a Latin American telecom operator",
    ),
    searched('"Valle Sereno"', "Residential developments outside Mexico, an apartment complex and a textile firm; no ISP, telecom brand or Mexican place"),
    searched('"Valle Sereno" internet telecom fibra ISP', "No ISP or telecom brand of that name"),
  ],
  "Fibra 200": [
    searched(
      '"Fibra 200" internet proveedor OR provedor OR empresa',
      "No company named Fibra 200. It replaces an earlier plan name that is also the trade name of an ISP",
    ),
    searched('"Fibra 200" plan internet megas', "Generic descriptive plan name (fiber + speed) used by several unrelated operators in different countries; not owned by a single company"),
    PLAN_TIERS_QUERY,
  ],
  "Fibra 300": [
    searched('"Fibra 300" plan internet hogar', "Generic descriptive plan name (fiber + speed) used by several unrelated operators in Spain and Latin America; not owned by a single company"),
    searched('"Fibra 300" provedor OR empresa OR ISP nombre', "No company named Fibra 300; only plans of several operators"),
    PLAN_OWNERS_QUERY,
    PLAN_TIERS_QUERY,
  ],
  "Fibra 500": [
    searched('"Fibra 500" plan internet megas', "Generic descriptive plan name (fiber + speed) used by several unrelated operators in Spain and Latin America; not owned by a single company"),
    searched('"Fibra 500" provedor internet empresa', "No company named Fibra 500; only 500-Mbps plans of several operators"),
    PLAN_OWNERS_QUERY,
    PLAN_TIERS_QUERY,
  ],
  "+52 55 0101 00xx": phoneBlock("55 0101 0000-55 0101 0099"),
  "+52 55 0102 00xx": phoneBlock("55 0102 0000-55 0102 0099"),
  "+52 55 0103 0xxx": phoneBlock("55 0103 0000-55 0103 0999"),
  "+52 55 0199 0001": phoneBlock("55 0199 0001"),
  "+52 55 02nn 0xxx": phoneBlock("55 0200 0000-55 0299 0999"),
  "+52 55 09xx xxxx": phoneBlock("55 0900 0000-55 0999 9999"),
};
