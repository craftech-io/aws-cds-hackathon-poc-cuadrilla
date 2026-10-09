// What each rule of a decision means, as the field-work views describe a chip (docs/design-brief.md §5.5
// to §5.10). A rule the map does not know keeps its chip without a description.
export const ruleMeaning: Readonly<Record<string, string>> = {
  "CP-KIND-CHANNEL": "Cada tipo de mensaje sale solo por su canal",
  "CP-ALLOWLIST": "Solo a teléfonos de la lista de permitidos",
  "CP-OPTIN": "Solo a quien aceptó recibir mensajes",
  "CP-OPTOUT": "Nada a quien pidió la baja",
  "CP-BRIDGE": "El puente solo entre el instalador y quien tomó el caso",
  "CP-ROSTER": "Solo a supervisores del turno",
  "CP-QUIET-HOURS": "Horario de silencio",
  "CP-ONE-DAYSTART": "Un solo inicio del día por instalador",
  "CP-WA-24H": "Ventana de 24 h de WhatsApp",
  "CP-TEMPLATE-APPROVED": "Solo plantillas aprobadas",
  "CP-RECIPIENT-FENCE": "Cerco de destinatarios de email",
  "CP-CERT-EVIDENCE": "El acta solo con evidencia validada",
  "CP-NO-SENSITIVE-ASK": "Nunca pedir datos personales",
  "CP-NO-FOREIGN-LINKS": "Sin enlaces ni contactos ajenos",
  "CP-CITATION": "Toda política sale del manual citado",
  G1: "Barrera de contenido de la entrada",
  G2: "Barrera de fundamento de la respuesta",
  G3: "Barrera de contenido del acta",
  "VAL-RANGE": "Lectura dentro del rango de la zona",
  "VAL-WAVELENGTH": "Medición en 1490 nm",
  "VAL-SERIAL": "Serial igual al de la orden",
  "VAL-READING": "Lectura coherente con la red",
  "VAL-CONFIDENCE": "Confianza mínima del validador",
  "LAD-TAKE": "Toma condicional del caso",
  "LAD-CONSOLE-ONLY": "Caso solo en la consola",
};

export function describeRule(ruleId: string): string | undefined {
  return ruleMeaning[ruleId];
}
