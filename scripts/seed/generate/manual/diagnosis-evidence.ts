// Manual v1, sections DIAG and EVI (docs/seed-spec.md §8): the common faults of an installation with
// their steps in order, when a fault is escalated, and the evidence a closing needs. Written from
// scratch with general public knowledge of FTTH troubleshooting.
import type { ManualSection } from "./types";

export const DIAGNOSIS_EVIDENCE_SECTIONS: readonly ManualSection[] = [
  {
    id: "DIAG-01",
    title: "ONU sin energía o que se reinicia",
    body: [
      "Si la ONU no enciende ninguna luz:",
      "",
      "1. Revisa que el eliminador esté bien conectado a la ONU y al contacto.",
      "2. Comprueba que el contacto tenga energía conectando otro aparato.",
      "3. Revisa que el botón de encendido de la ONU esté activado.",
      "",
      "Si la ONU se reinicia sola una y otra vez, la energía es inestable: conéctala a otro contacto sin extensiones ni multicontactos. Usa siempre el eliminador original.",
      "",
      "Si después de estos pasos sigue sin encender o reiniciándose, avisa: se escala a tu supervisor (§ESC-01).",
    ].join("\n"),
  },
  {
    id: "DIAG-02",
    title: "Luz PON apagada o parpadeando",
    body: [
      "La luz PON indica que la ONU se registró en la red. Apagada o parpadeando sin quedarse fija significa que no hay señal suficiente o que la ONU no termina de registrarse.",
      "",
      "1. Revisa que el cordón de parcheo esté bien conectado en la roseta y en la ONU, hasta escuchar el clic.",
      "2. Limpia los conectores SC/APC de los dos extremos (§INS-05) y vuelve a conectar.",
      "3. Revisa el drop y el cordón en busca de curvas cerradas o grapas apretadas (§INS-03).",
      "4. Pide que se verifique el estado de la ONU en el sistema: el asistente de campo lo consulta en el orquestador de red.",
      "",
      "Si la luz se queda fija, mide la potencia (§MED-02). Si sigue apagada después de tres pasos sin cambio, se escala (§ESC-01).",
    ].join("\n"),
  },
  {
    id: "DIAG-03",
    title: "Potencia fuera de rango",
    body: [
      "Cuando la lectura queda fuera del rango de la clase (§MED-01):",
      "",
      "1. Limpia los conectores de los dos extremos del cordón y el de la roseta, y vuelve a medir.",
      "2. Revisa los conectores y los empalmes a la vista: un conector flojo o dañado se cambia.",
      "3. Elimina macrocurvaturas: curvas cerradas, cable pellizcado o grapas que lo aplastan.",
      "",
      "Si después de tres pasos la potencia sigue fuera de rango, no insistas: se escala a tu supervisor con las lecturas que tomaste. Una lectura por encima de −8 dBm (sobrecarga) también se escala.",
    ].join("\n"),
  },
  {
    id: "DIAG-04",
    title: "ONU no aprovisionada",
    body: [
      "Si el sistema indica que la ONU no está aprovisionada, el instalador no la da de alta ni la configura: el aprovisionamiento lo hace la operadora.",
      "",
      "1. Confirma que el serial de la etiqueta de la ONU es el mismo que el de la orden.",
      "2. Si el serial coincide, se escala a tu supervisor para que se aprovisione.",
      "3. Si el serial no coincide, instalaste un equipo distinto al de la orden: avisa antes de continuar.",
    ].join("\n"),
  },
  {
    id: "DIAG-05",
    title: "En línea pero sin navegación",
    body: [
      "Si la ONU está en línea y la potencia en rango, pero el cliente no puede navegar:",
      "",
      "1. Revisa que el equipo del cliente esté conectado a la red WiFi correcta, con la clave de la etiqueta (§INS-07).",
      "2. Prueba con un cable de red directo a la ONU.",
      "3. Reinicia la ONU una sola vez y espera a que se estabilicen las luces.",
      "",
      "Si sigue sin navegar, se escala a tu supervisor (§ESC-01). No cambies la configuración de la ONU.",
    ].join("\n"),
  },
  {
    id: "EVI-01",
    title: "Evidencia requerida",
    body: [
      "Para cerrar una instalación se necesitan tres fotos, cada una validada:",
      "",
      "1. **Lectura del medidor**: la pantalla completa del medidor, con el valor de potencia y la longitud de onda (1490 nm) legibles.",
      "2. **Etiqueta de la ONU**: la etiqueta completa, con el serial legible de principio a fin.",
      "3. **Roseta instalada**: la caja fijada al muro con el conector visible.",
      "",
      "Cada foto tiene que estar enfocada, sin reflejo, con el encuadre completo y con buena luz. Apaga el flash, apoya el teléfono y toma la foto de frente. Una foto rechazada se repite siguiendo el motivo que te indica el asistente; al tercer rechazo del mismo ítem se escala a tu supervisor.",
      "",
      "Además del checklist de fotos, la ONU tiene que estar en línea con la potencia en rango y el cliente tiene que dar su conformidad (§CAL-01).",
    ].join("\n"),
  },
  {
    id: "EVI-02",
    title: "Acta de instalación",
    body: [
      "El acta de instalación se genera al cerrar la orden, solo cuando la evidencia está completa: los ítems del checklist validados, la ONU en línea con la potencia en rango y la conformidad del cliente.",
      "",
      "Incluye los datos de la orden, el serial de la ONU, la potencia recibida y la clase óptica, cada ítem con quién lo validó y las fotos validadas.",
      "",
      "Se envía al cliente por correo electrónico, al buzón de operaciones de la operadora y al instalador por WhatsApp. El instalador no la firma ni la imprime.",
    ].join("\n"),
  },
];
