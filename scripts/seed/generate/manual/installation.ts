// Manual v1, sections INS and MED (docs/seed-spec.md §8): the installation step by step and how the
// received power is measured and judged per optical class. Written from scratch with general public
// knowledge of FTTH/GPON; the acceptance ranges are the operator's (B+ −8 to −25 dBm, C+ −8 to −28 dBm).
import type { ManualSection } from "./types";

export const INSTALLATION_SECTIONS: readonly ManualSection[] = [
  {
    id: "INS-01",
    title: "Kit mínimo",
    body: [
      "Antes de salir a ruta revisa que traes, completo y funcionando:",
      "",
      "- Medidor de potencia óptica con la longitud de onda de 1490 nm y batería cargada.",
      "- Limpiador de conectores de un clic y tapas de repuesto.",
      "- Localizador visual de fallas (luz roja).",
      "- Cortadora de precisión y herramientas de pelado para fibra.",
      "- Grapas para cable, taquetes y tornillos para fijar la roseta.",
      "- Escalera dieléctrica.",
      "- Equipo de protección personal: casco, lentes de seguridad, guantes y calzado dieléctrico.",
      "",
      "Sin el medidor no se puede cerrar una instalación: la lectura de potencia es parte de la evidencia (§EVI-01).",
    ].join("\n"),
  },
  {
    id: "INS-02",
    title: "Llegada al domicilio",
    body: [
      "- Preséntate con tu gafete de la operadora y di a qué vienes.",
      "- Confirma que la persona que te recibe es la titular que aparece en la orden, o alguien que ella autorizó. Basta con el nombre: no hace falta ningún documento.",
      "- No pidas ni fotografíes identificaciones oficiales (credencial para votar, pasaporte, licencia) y no pidas datos bancarios, contraseñas ni pagos.",
      "- Explica en pocas palabras qué vas a hacer y pregunta dónde prefiere la roseta y la ONU, dentro de lo que permite §INS-04 y §COM-04.",
      "- Si hay un riesgo en el acceso, aplica §SEG-05 antes de entrar.",
    ].join("\n"),
  },
  {
    id: "INS-03",
    title: "Tendido del drop",
    body: [
      "- Respeta el radio de curvatura: nunca dobles el drop en un radio menor de 3 cm. Una curva cerrada hace perder potencia aunque la fibra no se rompa.",
      "- Fija el cable con grapas cada 30 cm, sin apretarlas al grado de aplastarlo.",
      "- Nunca lo dejes tendido por el piso ni por lugares de paso, y no lo lleves junto a cables de energía ni dentro de la misma canaleta.",
      "- Deja 1 m de reserva enrollada junto a la roseta para futuras reparaciones.",
      "- Si sobra más cable, enróllalo en vueltas amplias, respetando el radio de curvatura, y fíjalo en un punto protegido; no lo dejes suelto.",
      "- Entra al domicilio por un paso existente o por una perforación limpia y sellada.",
    ].join("\n"),
  },
  {
    id: "INS-04",
    title: "Roseta óptica",
    body: [
      "- Instálala a una altura de 30 a 40 cm sobre el piso.",
      "- Ubícala a menos de 1,5 m de un contacto eléctrico, para que la ONU se conecte con su eliminador sin extensiones.",
      "- Fíjala al muro con taquetes y tornillos; nunca la dejes colgando del cable ni pegada con cinta.",
      "- Conecta el drop, acomoda la reserva y cierra la tapa. La roseta queda cerrada al terminar.",
    ].join("\n"),
  },
  {
    id: "INS-05",
    title: "Limpieza de conectores",
    body: [
      "Un conector sucio es la causa más común de potencia baja y de luz PON apagada.",
      "",
      "- Limpia cada conector con el limpiador de un clic dos veces antes de cada conexión, también si es nuevo.",
      "- Nunca soples el conector ni toques la férula (la punta blanca) con los dedos.",
      "- Conecta de inmediato después de limpiar y coloca de nuevo las tapas de los conectores que queden libres.",
    ].join("\n"),
  },
  {
    id: "INS-06",
    title: "Ubicación y encendido de la ONU",
    body: [
      "- Coloca la ONU en un lugar ventilado, sobre una superficie firme.",
      "- No la metas dentro de muebles cerrados, cajones ni gabinetes, y no la pongas sobre equipos que se calientan (televisiones, decodificadores, consolas).",
      "- Conéctala solo con su eliminador original a un contacto que funcione.",
      "- Enciéndela y espera a que se estabilicen las luces antes de medir o de revisar el estado en el sistema.",
    ].join("\n"),
  },
  {
    id: "INS-07",
    title: "Configuración inicial",
    body: [
      "- El nombre de la red WiFi y su clave vienen impresos en la etiqueta de la ONU. Muéstraselos al cliente.",
      "- Si el cliente quiere cambiar el nombre de la red o la clave, lo hace él mismo desde la app de autogestión de la operadora; puedes enseñarle dónde está la opción, pero no lo haces tú.",
      "- El instalador no cambia el perfil de servicio ni la velocidad del plan.",
    ].join("\n"),
  },
  {
    id: "MED-01",
    title: "Rangos de potencia por clase",
    body: [
      "La potencia que se evalúa es la recibida en la ONU a 1490 nm. La clase óptica de la zona viene en la orden.",
      "",
      "| Clase | Rango aceptado para cerrar |",
      "|---|---|",
      "| B+ | de −8 a −25 dBm |",
      "| C+ | de −8 a −28 dBm |",
      "",
      "- Una lectura por encima de −8 dBm (por ejemplo, −7) es sobrecarga: no se cierra.",
      "- Una lectura por debajo del mínimo de la clase (por ejemplo, −26 en una zona B+) está fuera de rango: no se cierra y se revisa según §DIAG-03.",
      "- El mismo valor puede ser válido en una clase y no en la otra: −26,1 dBm cierra en C+ pero no en B+.",
      "- Una instalación con la potencia fuera de rango nunca se cierra.",
    ].join("\n"),
  },
  {
    id: "MED-02",
    title: "Cómo medir",
    body: [
      "- Configura el medidor en 1490 nm, la longitud de onda de bajada que recibe la ONU.",
      "- Limpia el cordón y los conectores (§INS-05) antes de medir.",
      "- Mide en el cordón que va a la ONU, desconectándolo de la ONU y conectándolo al medidor.",
      "- Espera a que el valor se estabilice y anótalo con su signo.",
      "- Toma la foto con la pantalla completa, donde se lean el valor en dBm y la longitud de onda; sin reflejos ni dedos encima.",
      "- Vuelve a conectar el cordón a la ONU al terminar.",
    ].join("\n"),
  },
];
