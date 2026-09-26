// The generator's own name lists (docs/seed-spec.md §5-§6): common Mexican first names and surnames,
// streets named after trees and flowers, invented neighborhoods and city. Every person and customer
// of every template comes from here (invariant 17), and each place name has its row in `NAMECHECK`.
// Customers are combined from the short lists by stepping through them; the fixed customers of the
// stories are listed as they are.

/** Fictitious city of the demo operator (docs/seed-spec.md §4). */
export const CITY = "Ciudad Esmeralda";

/** Invented neighborhoods and the zone each one is in. */
export const NEIGHBORHOODS = {
  "Las Lomitas": "zone-norte",
  Arboledas: "zone-norte",
  "El Mirador": "zone-norte",
  "Los Encinos": "zone-sur",
  "Valle Sereno": "zone-sur",
} as const;
export type Neighborhood = keyof typeof NEIGHBORHOODS;

export const NORTH_NEIGHBORHOODS = (Object.keys(NEIGHBORHOODS) as Neighborhood[]).filter((name) => NEIGHBORHOODS[name] === "zone-norte");
export const SOUTH_NEIGHBORHOODS = (Object.keys(NEIGHBORHOODS) as Neighborhood[]).filter((name) => NEIGHBORHOODS[name] === "zone-sur");

/** Trees and flowers the streets are named after. */
export const STREET_NAMES = [
  "Jacaranda",
  "Los Fresnos",
  "Olmo",
  "Ciprés",
  "Laurel",
  "Tulipán",
  "Magnolia",
  "Gardenia",
  "Azucena",
  "Nogal",
  "Cedro",
  "Álamo",
  "Pirul",
  "Bugambilia",
  "Camelia",
  "Dalia",
  "Violeta",
  "Orquídea",
  "Girasol",
  "Sauce",
  "Roble",
  "Ceiba",
  "Tabachín",
  "Alcanfor",
] as const;

export const STREET_KINDS = ["Calle", "Av.", "Privada", "Cerrada", "Andador"] as const;

/** First names of the staff (docs/seed-spec.md §4-§5) and of the customers. */
export const FIRST_NAMES = [
  // Staff and console users
  "Rogelio",
  "Karina",
  "Julián",
  "Beatriz",
  "Tomás",
  "Ernesto",
  "Lorena",
  "Adriana",
  "Héctor",
  "Paola",
  "Daniel",
  "Marisol",
  "Ricardo",
  "Lina",
  // Customers of the stories
  "Lucía",
  "Armando",
  "Rosa Elena",
  // Customers combined by the generator
  "Alma",
  "Bernardo",
  "Consuelo",
  "Efraín",
  "Elvira",
  "Fidel",
  "Genaro",
  "Imelda",
  "Leonel",
  "Maribel",
  "Noemí",
  "Olga",
  "Porfirio",
  "Reyna",
  "Samuel",
  "Susana",
  "Tránsito",
  "Ulises",
  "Yesenia",
  "Zenaida",
] as const;

/** Surnames of the staff and of the customers. */
export const LAST_NAMES = [
  // Staff and console users
  "Méndez",
  "Olvera",
  "Torres",
  "Salazar",
  "Aguilar",
  "Villalobos",
  "Ávila",
  "Solís",
  "Ibarra",
  "Reyes",
  "Fuentes",
  "Cárdenas",
  "Luna",
  "Carranza",
  // Customers of the stories
  "Treviño",
  "Guzmán",
  "Pineda",
  // Customers combined by the generator
  "Arriaga",
  "Barajas",
  "Cisneros",
  "Escamilla",
  "Galván",
  "Lozano",
  "Macías",
  "Nájera",
  "Ocampo",
  "Pacheco",
  "Quiroz",
  "Rentería",
  "Sepúlveda",
  "Trejo",
  "Urías",
  "Vega",
  "Zepeda",
] as const;

/** Names the generator combines for customers (the tail of each list, never a staff name). */
export const CUSTOMER_FIRST_NAMES = FIRST_NAMES.slice(FIRST_NAMES.indexOf("Alma"));
export const CUSTOMER_LAST_NAMES = LAST_NAMES.slice(LAST_NAMES.indexOf("Arriaga"));

/** Plans of the demo operator: fictitious names, never a real commercial offer. */
export const PLANS = ["Fibra 200", "Fibra 300", "Fibra 500"] as const;
export type Plan = (typeof PLANS)[number];
