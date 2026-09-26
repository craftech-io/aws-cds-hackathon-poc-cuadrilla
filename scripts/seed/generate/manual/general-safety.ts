// Manual v1, sections GEN and SEG (docs/seed-spec.md §8), written from scratch for the demo with
// general public knowledge of FTTH work and safety. §SEG-01 carries the fixed safety instruction of
// copy/es-MX.ts verbatim (ADR-0016): the text the installer receives and the section the agent cites
// are the same, and `npm run manual:check` fails if they drift. §GEN-01 carries the scope paragraph
// that the long voice note `vn-10` reads (scripts/seed/audio/texts.ts).
import { esMX } from "../../../../packages/bff/src/copy/es-MX";
import { LONG_NOTE_PARAGRAPH } from "../../audio/texts";
import type { ManualSection } from "./types";

const SCOPE_TITLE = "Alcance y uso del manual. ";

export const GENERAL_SAFETY_SECTIONS: readonly ManualSection[] = [
  {
    id: "GEN-01",
    title: "Alcance y uso del manual",
    body: [
      LONG_NOTE_PARAGRAPH.startsWith(SCOPE_TITLE) ? LONG_NOTE_PARAGRAPH.slice(SCOPE_TITLE.length) : LONG_NOTE_PARAGRAPH,
      "",
      "Cada sección tiene un identificador (por ejemplo, §COM-04) para que cualquier respuesta sobre un procedimiento o una política pueda citarla. Lo que este manual no dice no es una regla de la operadora: en ese caso se dice que no está en el manual y se ofrece consultar al supervisor de turno.",
      "",
      "Este manual es una demo sintética: los procedimientos son generales de la industria y las políticas comerciales son inventadas para la demostración.",
    ].join("\n"),
  },
  {
    id: "GEN-02",
    title: "Glosario",
    body: [
      "- **ONU** (también llamada ONT): el equipo terminal óptico que queda en el domicilio del cliente. Convierte la señal de la fibra en internet por cable de red y WiFi.",
      "- **OLT**: el equipo de la central que da servicio a muchas ONU a través de la red pasiva.",
      "- **PON / GPON**: la red óptica pasiva que une la OLT con las ONU mediante divisores; el instalador no la modifica.",
      "- **Caja terminal**: la caja en poste o fachada de donde sale la acometida hacia cada cliente.",
      "- **Drop** (acometida): el cable de fibra que va de la caja terminal al domicilio.",
      "- **Roseta**: la caja óptica que se fija en el muro dentro del domicilio; ahí termina el drop y se conecta el cordón hacia la ONU.",
      "- **Conector SC/APC**: el conector de color verde con pulido en ángulo que usa la red. No se mezcla con conectores azules (UPC).",
      "- **Cordón de parcheo**: el tramo corto de fibra con conectores que une la roseta con la ONU.",
      "- **dBm**: la unidad de la potencia óptica. Los valores son negativos: −20 dBm es más señal que −26 dBm.",
      "- **Medidor de potencia óptica**: el instrumento que mide la potencia recibida en una longitud de onda (nm).",
    ].join("\n"),
  },
  {
    id: "SEG-01",
    title: "Riesgo eléctrico",
    body: [
      "Aplica cuando en el sitio hay un cable de energía caído, pelado o suelto, chispas, humo u olor a quemado, alguien sintió una descarga, un transformador hace ruido o echa aceite, o la escalera, el drop o una persona tocaron una línea de energía. Ante la duda, trátalo como riesgo eléctrico.",
      "",
      "Instrucción de seguridad:",
      "",
      esMX.safetyInstruction,
      "",
      "El asistente de campo envía esta misma instrucción en cuanto detecta el riesgo y avisa en paralelo al supervisor de turno y a la jefatura de zona. La orden queda en espera hasta que el supervisor cierre el caso. Nunca intentes mover, cortar ni aislar un cable de energía: ese trabajo es de la compañía eléctrica o de un electricista autorizado.",
    ].join("\n"),
  },
  {
    id: "SEG-02",
    title: "Trabajo en altura y escaleras",
    body: [
      "- Nunca subas a los postes de la red eléctrica ni a estructuras que sostengan cables de energía. Si el drop solo puede pasar por un poste de ese tipo, no lo hagas: consulta a tu supervisor.",
      "- Usa escalera dieléctrica (de fibra de vidrio) en buen estado: peldaños completos, zapatas antideslizantes y seguros trabados.",
      "- Coloca la escalera en relación 4:1: por cada 4 metros de altura, separa la base 1 metro del muro. Apóyala en piso firme y seco, nunca sobre cajas o muebles.",
      "- Mantén tres puntos de apoyo al subir y bajar (dos manos y un pie, o dos pies y una mano) y sube las herramientas en un cinturón o bolsa.",
      "- Por encima de 1,8 metros usa arnés con línea de vida anclada a un punto firme.",
      "- No recargues la escalera en cables, en ramas ni cerca de líneas de energía. Si hay viento fuerte o el piso está mojado, no subas.",
    ].join("\n"),
  },
  {
    id: "SEG-03",
    title: "Seguridad láser",
    body: [
      "La fibra transporta luz infrarroja invisible que puede dañar la vista aunque no la veas.",
      "",
      "- Nunca mires el extremo de una fibra ni el frente de un conector, esté o no conectado a la red.",
      "- Para saber si llega señal, usa el medidor de potencia óptica: es la única prueba válida.",
      "- El localizador visual de fallas emite luz roja visible: apúntalo solo hacia el conector y nunca hacia los ojos de nadie.",
      "- Coloca de nuevo las tapas de los conectores que no uses y guarda los recortes de fibra en un recipiente cerrado: son astillas de vidrio.",
    ].join("\n"),
  },
  {
    id: "SEG-04",
    title: "Clima",
    body: [
      "- Con tormenta eléctrica (truenos o rayos cerca) suspende de inmediato todo trabajo en exteriores y en altura: baja de la escalera, aléjate de postes, cables y fachadas metálicas y resguárdate en un lugar cerrado.",
      "- Reanuda solo cuando hayan pasado 30 minutos desde el último trueno.",
      "- Con lluvia intensa o viento fuerte no uses la escalera en exteriores.",
      "- Avisa por el asistente de campo si la suspensión te hace perder la ventana de cita, para que la orden se reprograme.",
    ].join("\n"),
  },
  {
    id: "SEG-05",
    title: "Entorno inseguro",
    body: [
      "Si en el domicilio o en el camino hay animales sueltos o agresivos, una amenaza, una agresión o cualquier situación que te haga sentir en peligro:",
      "",
      "- No entres ni insistas. Retírate a un lugar seguro.",
      "- Avisa de inmediato: el asistente de campo alerta a tu supervisor de turno.",
      "- No discutas ni negocies con quien amenaza. Tu seguridad va primero que la instalación.",
      "- Si no se puede trabajar, la visita puede registrarse como fallida y la orden se reprograma (§COM-05).",
    ].join("\n"),
  },
];
