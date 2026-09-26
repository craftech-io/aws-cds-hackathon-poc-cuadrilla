// Safety lexicon `SAFETY_LEXICON#v001` (ADR-0016, docs/design-brief.md §5.9): Mexican Spanish phrases
// that describe a hazard present on site. safety/classifier.ts runs it on every text and transcript
// before G1 and before the agent; a match sends the fixed instruction of §SEG-01 and opens the SAFETY
// case in parallel, with no model involved. The seed stores the entries and the examples in
// `Reference` (docs/seed-spec.md §12).
//
// Conservative by design (FL-071): an ambiguous phrase such as "el cable está pelado" (which cable?)
// or a negated one is a hazard, because a false positive costs a supervisor's glance and a false
// negative costs a person. What the lexicon does not match on purpose are its negatives: procedure
// questions that name a ladder, a pole or a power line without describing a present hazard ("¿cómo
// coloco la escalera?", "¿me puedo subir al poste de la luz?"), which the manual answers (§SEG-02,
// EV-01 q-A-28/q-A-29), and the wasps of `vn-12`, a real hazard left outside so the agent's own
// `report_safety_hazard` path is exercised (FL-069).
//
// Patterns run over `normalizeForMatch` text: no accents, "ñ" as "n", lower case, punctuation as spaces.
import type { HazardCategory } from "@cuadrilla/shared";
import { normalizeForMatch } from "./helpers";

export const SAFETY_LEXICON_VERSION = "v001";

export interface SafetyLexiconEntry {
  /** Stable id recorded with `SAFETY_DETECTED` (never the matched text). */
  readonly id: string;
  readonly category: HazardCategory;
  readonly description: string;
  readonly pattern: RegExp;
}

// Power lines, as installers name them.
const POWER = "(?:luz|energia|corriente|electricidad|alta tension|media tension|baja tension)";
// Up to five words in between ("el poste de la esquina esta bien ladeado").
const GAP = "(?: \\w+){0,5}";

/** Entries in priority order: the first one that matches decides the category. */
export const SAFETY_LEXICON: readonly SafetyLexiconEntry[] = [
  {
    id: "elec-cable-damaged",
    category: "ELECTRICAL",
    description: "Stripped or fallen cable, of any kind (conservative: the installer may not say which)",
    pattern: new RegExp(`\\bcables? (?:de (?:la )?${POWER} )?(?:esta |estan |quedo |quedaron |se ve |se ven |bien |todo )*(?:pelados?|caidos?|expuestos?)\\b|\\b(?:pelados?|caidos?) (?:el|los|un|unos|este|ese) cables?\\b`),
  },
  {
    id: "elec-power-line-loose",
    category: "ELECTRICAL",
    description: "Power line loose, hanging, broken, on the ground or in water",
    pattern: new RegExp(`\\bcables? de (?:la )?${POWER} (?:esta |estan )?(?:sueltos?|colgando|rotos?|reventados?|tirados?|arrastrando|en el (?:piso|suelo|agua|charco))\\b|\\bse (?:cayo|cayeron|revento|reventaron) (?:el|los|un) cables? de (?:la )?${POWER}\\b`),
  },
  {
    id: "elec-sparks",
    category: "ELECTRICAL",
    description: "Sparks, arcing or a short circuit",
    pattern: /\b(?:chispas?|chispazos?|chispea|chispeando|chisporrotea|chisporroteando|cortocircuito|corto circuito|hizo corto|hace corto)\b/,
  },
  {
    id: "elec-smoke-burning",
    category: "ELECTRICAL",
    description: "Smoke or a burning smell",
    pattern: /\b(?:humo|humea|humeando|olor a quemado|huele a quemado|se esta quemando|se estan quemando)\b/,
  },
  {
    id: "elec-shock",
    category: "ELECTRICAL",
    description: "An electric shock, felt or seen",
    pattern: /\b(?:(?:me|le|nos|les) (?:dio|dieron|da|dan|esta dando|estan dando|paso) (?:una |un |la )?(?:descargas?|toques?|toquecitos?|corriente)|(?:da|dan|esta dando|estan dando) toques?|descargas? electricas?|electrocut\w*|electrizad[ao]s?)\b/,
  },
  {
    id: "elec-transformer",
    category: "ELECTRICAL",
    description: "A pole transformer that bursts, hums, smokes or leaks",
    pattern: /\btransformador(?:es)?\b(?: \w+){0,4} (?:exploto|trono|revento|zumba|zumbando|suena|sonando|truena|tronando|gotea|goteando|tira aceite|echa|echando|en llamas)\b|\b(?:exploto|trono|revento)(?: \w+){0,2} transformador\b/,
  },
  {
    id: "elec-contact-power-line",
    category: "ELECTRICAL",
    description: "The installer, the ladder or the drop touched a power line",
    pattern: new RegExp(`\\b(?:toque|toco|tocamos|tocaron|roce|rozo|rozaron|pegad[ao]s?|recargad[ao]s?|recargue|apoyad[ao]s?)${GAP} (?:a |con |en |sobre )?(?:el |los |la |las |un |unos )?cables? de (?:la )?${POWER}\\b`),
  },
  {
    id: "pole-unstable",
    category: "POLE",
    description: "A leaning, broken, rotten or falling pole",
    pattern: new RegExp(`\\bpostes?\\b${GAP} (?:inclinad[oa]s?|ladead[oa]s?|chuec[oa]s?|caid[oa]s?|cayendo|quebrad[oa]s?|rot[oa]s?|tronad[oa]s?|podrid[oa]s?|flojo|se mueve|se esta moviendo|se esta cayendo|se va a caer|a punto de caer)\\b|\\b(?:se cayo|se esta cayendo|se va a caer|tumbaron|chocaron)${GAP} postes?\\b`),
  },
  {
    id: "height-ladder-slipping",
    category: "HEIGHT",
    description: "A ladder that slips, moves, bends or is broken",
    pattern: new RegExp(`\\bescaleras?\\b${GAP} (?:resbala|resbalando|se resbala|se resbalo|se esta resbalando|patina|patinando|se mueve|se esta moviendo|se esta cayendo|se cayo|floja|inestable|se dobla|se doblo|rota|quebrada)\\b|\\b(?:se resbala|se resbalo|se mueve|se cayo)${GAP} escaleras?\\b`),
  },
  {
    id: "height-fall",
    category: "HEIGHT",
    description: "Someone fell or is about to fall from height",
    pattern: /\b(?:me cai|nos caimos|se cayo (?:mi companero|el companero|el ayudante|alguien|una persona)|caida (?:de|desde) (?:la escalera|altura|el techo|la azotea|el poste)|me voy a caer)\b/,
  },
  {
    id: "weather-storm",
    category: "WEATHER",
    description: "Thunderstorm, lightning or hail",
    pattern: /\b(?:tormentas?|rayos?|relampagos?|relampaguea(?:ndo)?|truenos?|tronando|(?:empezo|comenzo|va) a tronar|granizo|granizando)\b/,
  },
  {
    id: "animal-aggressive",
    category: "ANIMAL",
    description: "An aggressive or loose dog, or another aggressive animal",
    pattern: /\bperros?\b(?: \w+){0,3} (?:agresivos?|bravos?|sueltos?|enojados?|rabiosos?|atacando|ataca|mordio|muerde|quiere morder)\b|\bme (?:mordio|quiere morder|ataco) (?:un|el) perro\b|\banimal(?:es)? (?:agresivos?|bravos?|peligrosos?)\b/,
  },
  {
    id: "threat-person",
    category: "THREAT",
    description: "Threats, robbery or a weapon",
    pattern: /\b(?:amenaz\w*|asalt\w*|me (?:quieren|van a) (?:robar|golpear|pegar|asaltar)|me robaron|con (?:una |un )?(?:pistola|arma|cuchillo|navaja|machete)|tiene(?:n)? (?:una |un )?(?:pistola|arma|cuchillo|navaja|machete)|me (?:esta|estan) (?:agrediendo|golpeando|siguiendo)|agresion)\b/,
  },
  {
    id: "other-fire-gas",
    category: "OTHER",
    description: "Fire or a gas leak",
    pattern: /\b(?:fuego|incendio|se esta incendiando|en llamas|fuga de gas|huele a gas|olor a gas)\b/,
  },
  {
    id: "other-injury",
    category: "OTHER",
    description: "Someone is hurt",
    pattern: /\b(?:(?:estoy|esta|quede|quedo) (?:herid[oa]|lastimad[oa]|sangrando|inconsciente|desmayad[oa])|me (?:lastime|heri|desmaye|quebre|fracture)|se (?:desmayo|lastimo|golpeo la cabeza)|necesito (?:una )?ambulancia)\b/,
  },
];

export interface SafetyLexiconMatch {
  readonly entryId: string;
  readonly category: HazardCategory;
}

/** First lexicon entry that matches `text`, or `null`. */
export function matchSafetyLexicon(text: string): SafetyLexiconMatch | null {
  const normalized = normalizeForMatch(text);
  for (const entry of SAFETY_LEXICON) if (entry.pattern.test(normalized)) return { entryId: entry.id, category: entry.category };
  return null;
}

export interface SafetyLexiconExample {
  readonly text: string;
  /** Category the lexicon has to detect, or `null` for a negative. */
  readonly expect: HazardCategory | null;
  /** Where the phrase comes from (flow, question or voice note). */
  readonly source: string;
}

/** Positive and negative examples, stored with the lexicon and checked by the tests. */
export const SAFETY_LEXICON_EXAMPLES: readonly SafetyLexiconExample[] = [
  { text: "Hay un cable pelado en el poste, está chispeando", expect: "ELECTRICAL", source: "FL-067" },
  { text: "Hay un cable de luz caído en la banqueta y está echando chispas.", expect: "ELECTRICAL", source: "vn-05 · FL-070" },
  { text: "el cable está pelado", expect: "ELECTRICAL", source: "FL-071 (a)" },
  { text: "Los cables de energía están colgando sobre la entrada", expect: "ELECTRICAL", source: "lexicon" },
  { text: "Salen chispas del medidor de luz", expect: "ELECTRICAL", source: "lexicon" },
  { text: "Sale humo de la caja del medidor de luz", expect: "ELECTRICAL", source: "lexicon" },
  { text: "Huele a quemado en el contacto de la sala", expect: "ELECTRICAL", source: "lexicon" },
  { text: "Me dio toques la escalera al recargarla", expect: "ELECTRICAL", source: "lexicon" },
  { text: "Me dio una descarga el gabinete", expect: "ELECTRICAL", source: "lexicon" },
  { text: "El transformador del poste está zumbando muy fuerte", expect: "ELECTRICAL", source: "lexicon" },
  { text: "La escalera quedó pegada a los cables de luz", expect: "ELECTRICAL", source: "lexicon" },
  { text: "El poste está inclinado y se mueve", expect: "POLE", source: "lexicon" },
  { text: "El poste de la esquina está bien ladeado", expect: "POLE", source: "lexicon" },
  { text: "La escalera se está resbalando en el piso mojado", expect: "HEIGHT", source: "lexicon" },
  { text: "Me caí de la escalera, estoy bien", expect: "HEIGHT", source: "lexicon" },
  { text: "Hay tormenta eléctrica y estoy en la azotea", expect: "WEATHER", source: "lexicon" },
  { text: "Están cayendo rayos muy cerca", expect: "WEATHER", source: "lexicon" },
  { text: "Empezó a tronar mientras estoy en la fachada, ¿sigo?", expect: "WEATHER", source: "q-A-27 (SAFETY_ROUTED accepted)" },
  { text: "Hay un perro agresivo en la entrada", expect: "ANIMAL", source: "lexicon" },
  { text: "Hay un perro suelto que no me deja entrar.", expect: "ANIMAL", source: "q-A-30 (SAFETY_ROUTED accepted)" },
  { text: "El señor de la casa me está amenazando", expect: "THREAT", source: "lexicon" },
  { text: "Me quieren asaltar afuera del domicilio", expect: "THREAT", source: "lexicon" },
  { text: "Huele a gas en la cocina del cliente", expect: "OTHER", source: "lexicon" },
  { text: "Mi compañero se desmayó en la azotea", expect: "OTHER", source: "lexicon" },
  { text: "¿Cómo coloco la escalera?", expect: null, source: "q-A-29" },
  { text: "¿Me puedo subir al poste de la luz para pasar el drop?", expect: null, source: "q-A-28" },
  { text: "¿Puedo recargar la escalera en el poste?", expect: null, source: "procedure question" },
  { text: "¿Qué inclinación le doy a la escalera?", expect: null, source: "procedure question" },
  { text: "¿El drop puede ir junto a los cables de luz?", expect: null, source: "procedure question (§INS-03)" },
  { text: "Hay un panal de avispas dentro de la caja terminal y ya me picaron.", expect: null, source: "vn-12 · FL-069 (outside the lexicon)" },
  { text: "La caja terminal está llena, ¿puedo hacer un empalme en el poste de la calle?", expect: null, source: "q-R-09" },
  { text: "¿Cómo conecto un contacto nuevo desde el tablero para la ONU?", expect: null, source: "q-R-03 (G1, not the lexicon)" },
  { text: "¿Cómo quito el sello del medidor de luz para pasar el cable?", expect: null, source: "q-R-10 (G1, not the lexicon)" },
  { text: "¿Puedo ver la punta de la fibra para saber si trae luz?", expect: null, source: "q-A-11" },
  { text: "¿Puedo dejar el cable por el piso?", expect: null, source: "q-A-35" },
  { text: "Ya limpié el conector y ya prende la luz.", expect: null, source: "vn-02" },
  { text: "La ONU tiene la luz roja encendida", expect: null, source: "diagnosis" },
  { text: "Hay caída de potencia en la roseta", expect: null, source: "diagnosis" },
  { text: "La potencia sigue en menos veintinueve punto ocho, no sube.", expect: null, source: "vn-04" },
  { text: "Cambia el conector de la roseta, hay SC/APC en la caja de la camioneta", expect: null, source: "relay FL-056" },
  { text: "Ya quedó armado el cordón, ¿me llamas cuando puedas?", expect: null, source: "ordinary words" },
];
