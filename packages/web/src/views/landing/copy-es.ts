// Texts of the public landing in Mexican Spanish (tú), from docs/landing-spec.md §1, its only source.
// What the captures of the console show is not here: the product itself writes it. Nothing here names
// the operator: the brand line and the synthetic-demo notice come from the stage's brand configuration
// at runtime (ADR-0018).

export type SceneKey = "S1" | "S2" | "S3" | "S4" | "S5" | "S6";

export const es = {
  htmlLang: "es-MX",
  lang: { label: "Cambiar el idioma a inglés", switchTo: "English", short: "EN" },
  skipToContent: "Ir al contenido",
  nav: { label: "Accesos", signIn: "Ingresar", tryDemo: "Probar la demo", talk: "Hablemos", newTab: "se abre en una pestaña nueva" },
  hero: {
    eyebrow: "Copiloto de campo en WhatsApp",
    title: "Cada instalación, cerrada con evidencia a la primera",
    lead: "El instalador de fibra trabaja solo, con las manos ocupadas. Le escribe a Cuadrilla por WhatsApp — con texto o una nota de voz — y el agente lo guía con el manual de la operadora, revisa cada foto antes de aceptarla y avisa a un supervisor cuando hace falta una persona.",
    note: "Entorno de demostración con datos sintéticos, en unos minutos. Tu cuenta y tu propio mundo de prueba se crean al confirmar tu email.",
    loop: {
      label: "Cuadrilla en un teléfono: una instalación de principio a fin",
      pause: "Pausar animación",
      play: "Reproducir animación",
      summary: (voiceText: string) =>
        `Una instalación en cinco momentos: el instalador manda una nota de voz ("${voiceText}"), Cuadrilla responde citando la sección del manual, rechaza una foto con reflejo, acepta la siguiente con ✅ y le manda el acta en PDF.`,
    },
  },
  problem: {
    title: "El problema",
    lead: "Tres dolores de todos los días en una operación de instalaciones de fibra.",
    before: "Hoy",
    after: "Con Cuadrilla",
    items: [
      {
        title: "Dudas en sitio",
        before: "Llama o le escribe a su jefe de equipo y espera; si no contesta, improvisa.",
        after: "Pregunta por WhatsApp — texto o nota de voz — y en segundos tiene la respuesta del manual, con la sección citada.",
      },
      {
        title: "Revisitas por evidencia mala",
        before: "La instalación se cierra con fotos borrosas o sin la lectura de potencia; el acta se arma después, a mano.",
        after: "Cada foto se revisa al llegar, con un motivo accionable si no sirve (\"hay reflejo: inclina el teléfono\"), y el acta sale sola con la evidencia validada.",
      },
      {
        title: "Escalamientos que nadie toma",
        before: "El supervisor no ve el mensaje a tiempo y el instalador espera sin saber qué pasa.",
        after: "Una escalera con tiempos: supervisor de turno, de respaldo y, si nadie responde, aviso al jefe de zona por email.",
      },
    ],
  },
  walkthrough: {
    title: "Así trabaja un instalador con Cuadrilla",
    lead: "Seis momentos de una instalación, de principio a fin — mira cómo cambia la pantalla en cada paso.",
    stepOf: (at: number, of: number) => `${at}/${of}`,
    order: (workOrderNumber: string) => `Orden ${workOrderNumber}`,
    progress: "Avance de la escena",
    realLabel: "Qué es real",
    scenes: {
      S1: {
        title: "La conversación se escribe sola",
        lines: [
          "Rogelio llega al domicilio y la ONU no prende la luz PON. Manda una nota de voz, sin soltar las herramientas.",
          "Cuadrilla transcribe el audio, lee el estado de la ONU y responde con el paso del manual, citando la sección.",
        ],
        real: "WhatsApp (simulado en esta demo con el simulador de teléfono), Transcribe, AgentCore, Knowledge Base",
      },
      S2: {
        title: "La decisión que toma el sistema",
        lines: [
          "Una pregunta de política se contesta solo con lo que dice el manual, y con su sección.",
          "Lo que el manual no cubre no se inventa: Cuadrilla lo dice y ofrece consultarlo con la supervisora.",
        ],
        real: "AgentCore, Knowledge Base, Guardrails",
      },
      S3: {
        title: "El chequeo de foto",
        lines: [
          "Cada foto se revisa al llegar, en una llamada aislada con chequeos deterministas.",
          "Si no sirve, recibe la reacción 🔁 y un motivo que se puede corregir en el momento; la siguiente pasa con ✅.",
        ],
        real: "Bedrock (validación aislada), chequeos deterministas",
      },
      S4: {
        title: "El acta y el buzón de salida",
        lines: [
          "Con el checklist completo, Rogelio toca Cerrar instalación en WhatsApp y recibe el acta en PDF.",
          "Al mismo tiempo, el acta sale por email al cliente y al buzón de operaciones; en esta demo, al simulador de buzones.",
        ],
        real: "SES, generación del PDF",
      },
      S5: {
        title: "La escalación",
        lines: [
          "Tres pasos de diagnóstico sin cambio abren un caso: la supervisora de turno recibe la plantilla con Tomar caso y No puedo.",
          "Si nadie lo toma en 10 minutos, pasa al supervisor de respaldo. Héctor lo toma, recibe el resumen y le responde a Rogelio por el mismo WhatsApp.",
        ],
        real: "WhatsApp (simulado), Cognito; deterministas: la escalera y el puente",
      },
      S6: {
        title: "La seguridad",
        lines: [
          "Un mensaje con un riesgo físico lo detecta un clasificador determinista, antes del agente.",
          "La instrucción de seguridad es siempre el mismo texto del manual, completo y al instante; la supervisora y la jefa de zona reciben el aviso en segundos.",
        ],
        real: "Deterministas: el clasificador y la instrucción fija; real: SES",
      },
    } satisfies Record<SceneKey, { title: string; lines: readonly string[]; real: string }>,
  },
  actors: {
    title: "Qué hace, por actor",
    groups: [
      {
        actor: "Instalador",
        items: [
          "Pregunta por WhatsApp y recibe la respuesta del manual citada",
          "Ve qué le falta para cerrar y por qué se rechazó una foto",
          "Pide ayuda a su supervisor con un botón",
          "Recibe su acta en el momento",
        ],
      },
      {
        actor: "Supervisor",
        items: [
          "Recibe solo lo que necesita a una persona, con el resumen y las fotos",
          "Toma o pasa un caso con un botón",
          "Responde al instalador sin salir de WhatsApp",
          "Valida manualmente una foto dudosa desde la consola",
        ],
      },
      {
        actor: "Jefe de zona",
        items: ["Se entera de un riesgo de seguridad en menos de un minuto", "Recibe por email los casos que nadie tomó", "No necesita WhatsApp: le llega por email"],
      },
      {
        actor: "Operaciones",
        items: [
          "Ve cada instalación del día, con su checklist y su estado de red",
          "Revisa la bitácora de decisiones y las reglas aplicadas",
          "Exporta el acta y las métricas",
        ],
      },
    ],
  },
  trust: {
    title: "Lo que Cuadrilla nunca hace",
    lead: "Reglas garantizadas en código, no en una instrucción al modelo.",
    items: [
      {
        title: "Cita siempre su fuente",
        text: "Toda respuesta de política o procedimiento cita la sección del manual; si el manual no lo cubre, lo dice y ofrece escalar — nunca inventa una política.",
      },
      { title: "La instrucción de seguridad no la escribe un modelo", text: "Ante un riesgo físico, el texto de seguridad es el mismo, fijo, del manual — no lo redacta el agente." },
      {
        title: "Una foto dudosa la decide una persona",
        text: "El chequeo de evidencia asiste y puede aceptar una foto por su cuenta; validar manualmente una foto dudosa es siempre decisión de una persona, con su propio usuario.",
      },
      { title: "Nunca cobra ni promete", text: "El agente no cambia precios, no ofrece descuentos ni compensaciones — esas preguntas se escalan." },
      { title: "Cada decisión queda registrada", text: "Toda regla que se aplicó, todo mensaje que salió y por qué, quedan en una bitácora auditable." },
      { title: "Solo habla con quien corresponde", text: "Un mensaje sale solo a quien tiene el consentimiento vigente y el rol correcto — nunca a un número o una persona fuera de la política." },
    ],
  },
  impact: {
    title: "Impacto",
    lead: "Metas del producto y un supuesto de piloto, rotulados como tales: ninguna cifra es un resultado medido en producción.",
    goal: "meta",
    assumption: "supuesto",
    items: [
      { kind: "up" as const, value: 70, prefix: "≥ ", suffix: " %", text: "de las preguntas del instalador, resueltas sin escalar y con la sección correcta citada", source: "se mide sobre las 40 preguntas del set del manual" },
      { kind: "cap" as const, value: 30, prefix: "< ", suffix: " s", text: "tiempo hasta la primera respuesta del agente (texto)", source: "objetivo p95 del turno de texto" },
      { kind: "up" as const, value: 90, prefix: "≥ ", suffix: " %", text: "exactitud del chequeo de fotos de evidencia contra un set etiquetado", source: "se mide sobre 60 fotos etiquetadas" },
      { kind: "cap" as const, value: 60, prefix: "< ", suffix: " s", text: "desde un riesgo reportado hasta el aviso al jefe de zona", source: "objetivo de la alerta de seguridad" },
    ],
    pilot: "En un piloto mediríamos revisitas a 30 días y minutos por instalación contra tu línea de base.",
  },
  video: {
    title: "Una instalación en tres minutos",
    lead: "El instalador en WhatsApp, el supervisor que toma un caso y la consola de la operadora, en un solo recorrido.",
    label: "Video de Cuadrilla: una instalación de principio a fin",
    note: "El video se descarga solo cuando lo reproduces.",
    fallback: "Descargar el video (MP4)",
  },
  integration: {
    title: "Cómo se integra",
    diagramLabel: "Cómo se conecta Cuadrilla con la operación",
    diagram: {
      installer: "Instalador (WhatsApp)",
      agent: "Cuadrilla (agente)",
      manual: "Manual de la operadora (base de conocimiento)",
      connectors: "Orquestador de red · Sistema de despacho",
      connectorsNote: "conectores del lado de la operadora",
      people: "Supervisor (WhatsApp) · Jefe de zona (email) · Consola",
    },
    rows: [
      { block: "Canal", text: "WhatsApp, sobre AWS End User Messaging Social — el mismo canal que ya usa el instalador, sin una app nueva que instalar; en esta demo, con un simulador de teléfono." },
      { block: "Agente", text: "Un agente sobre Amazon Bedrock AgentCore que decide qué hacer con cada mensaje, siempre con las herramientas y los datos de la orden en curso — nunca a ciegas." },
      { block: "Conocimiento", text: "El manual de procedimientos de la operadora, en una base de conocimiento propia: el agente responde solo desde ahí y cita la sección." },
      {
        block: "Conectores de la operadora",
        text: "Dos integraciones del lado de la operadora: el estado del equipo de red (para saber si la conexión quedó en línea) y el sistema de asignación de órdenes (para saber la agenda del día). En esta demo, ambos están simulados con datos sintéticos — el contrato de integración es real.",
      },
      { block: "Notificación por email", text: "Amazon SES entrega el acta al cliente y a operaciones, y avisa al jefe de zona ante un riesgo." },
      { block: "Infraestructura", text: "Todo serverless sobre AWS: sin servidores que mantener, sin capacidad que reservar de antemano." },
      { block: "Seguridad", text: "Cada operadora ve solo sus propios datos; el acceso a la consola es con su propio usuario." },
    ],
    needs: "Qué necesita tu operación: tu manual de procedimientos, acceso de lectura al estado de la ONU y a las órdenes del día, una cuenta de WhatsApp Business conectada por AWS End User Messaging Social, y un buzón para las actas.",
  },
  real: {
    title: "Qué es real y qué es simulado",
    columns: [
      { title: "Real", text: "Todo servicio de nube que hace el trabajo: el agente (Bedrock AgentCore), el chequeo de fotos, la transcripción de voz, el envío de emails, el almacenamiento y el inicio de sesión." },
      {
        title: "Implementado, se prueba en el simulador",
        text: "WhatsApp, implementado sobre AWS End User Messaging Social: en tu demo lo pruebas en el simulador de teléfono de la consola, que pasa por el mismo agente, las mismas reglas y el mismo circuito de mensajes.",
      },
      { title: "Mocks propios", text: "El despacho de órdenes, el orquestador de red (ONU), el personal, los clientes y los teléfonos." },
      { title: "Datos", text: "100 % sintéticos: toda persona, dirección, orden de trabajo y manual de esta demo es inventado. Nadie tuyo va a aparecer en ninguna captura." },
    ],
    email: "SES manda emails de verdad, dirigidos a un buzón de prueba que ves en el buzón de salida.",
    yourTrial: "Al probar la demo entras a tu propio mundo aislado, con datos sintéticos que nadie más ve ni toca.",
    staged: "Algunas partes de la consola se habilitan por etapas; tu mundo te muestra cuáles ya puedes usar.",
    renders: "Las pantallas de esta página están hechas con los componentes y los textos reales del producto; ilustran el producto y no son una sesión en vivo.",
  },
  gallery: {
    title: "Galería",
    lead: "La consola de la operadora, vista por vista. Toca una pantalla para ampliarla.",
  },
  finalCta: {
    title: "¿Lo probamos?",
    lead: "Crea tu cuenta y entra a tu propio mundo de prueba en unos minutos.",
    todayTitle: "Qué puedes hacer hoy en tu demo",
    todayNow: ["Crear tu cuenta con tu email", "Entrar a tu propio mundo de prueba, sembrado con datos sintéticos", "Ver en tu portada qué partes de la consola ya puedes usar"],
    todayFull: "Serás Rogelio en un simulador de teléfono, Adriana en la consola y controlas el reloj del mundo; recorrido exprés de 5 minutos.",
  },
  footer: { label: "Pie de página", privacy: "Privacidad", terms: "Términos", talk: "Hablemos" },
  media: { placeholderTitle: "Captura pendiente de la corrida en el stage", placeholderNote: "captura pendiente" },
  zoom: { open: "Ampliar imagen", close: "Cerrar", previous: "Imagen anterior", next: "Imagen siguiente", counter: (at: number, of: number) => `${at} de ${of}` },
};

export type LandingCopy = typeof es;
