// Texts of `/join` in Mexican Spanish (tú) and English, with the same keys (join-model.test.ts). The
// opt-in poster itself is the product's fixed text (`optInPoster` of copy/es-MX.ts and its gloss): it is
// never retyped here. Nothing here names the operator: the brand line comes from `brand.get`.

export const joinCopy = {
  es: {
    htmlLang: "es-MX",
    title: "Alta de personal",
    lead: "Cada instalador y cada supervisor se da de alta una sola vez, desde su propio WhatsApp.",
    keyword: "Envía",
    qrLabel: "Código QR que abre el simulador de teléfono de la consola",
    simulated:
      "En esta demo WhatsApp funciona con un simulador de teléfono: escanea el código o toca el botón para abrir el simulador en la consola y enviar ALTA desde la identidad de la persona.",
    open: "Abrir el simulador",
    signInNote: "El simulador está dentro de la consola: te pide iniciar sesión con tu cuenta de la demo.",
    back: "Volver al inicio",
    switchTo: "English",
    switchLabel: "Cambiar el idioma a inglés",
  },
  en: {
    htmlLang: "en",
    title: "Staff opt-in",
    lead: "Every installer and every supervisor opts in once, from their own WhatsApp.",
    keyword: "Send",
    qrLabel: "QR code that opens the console's phone simulator",
    simulated: "In this demo WhatsApp runs on a phone simulator: scan the code or tap the button to open the simulator in the console and send ALTA as that person.",
    open: "Open the simulator",
    signInNote: "The simulator lives inside the console: it asks you to sign in with your demo account.",
    back: "Back to the home page",
    switchTo: "Español",
    switchLabel: "Switch the language to Spanish",
  },
} as const satisfies Record<"es" | "en", Record<string, string>>;

export type JoinLang = keyof typeof joinCopy;
