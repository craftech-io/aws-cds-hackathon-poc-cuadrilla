// Texts of the guest's portada (`/app/home`), in Mexican Spanish (tuteo) and English. The five states,
// the expiry, the rolling-out block and the deletion are the texts of docs/landing-spec.md §7.6; the
// labels around them follow the console's voice. Nothing here names the operator: its visible name
// comes from the world (`resolveBrand`, ADR-0018).
import type { Weekday } from "@cuadrilla/shared";

export type GuestHomeLang = "es" | "en";

const CONTACT_URL = "https://craftech.io/contact/";

export const guestHomeCopy = {
  es: {
    htmlLang: "es-MX",
    heading: "Tu mundo de prueba",
    contactUrl: CONTACT_URL,
    provisioning: {
      title: "Estamos preparando tu mundo de prueba.",
      lead: "Tu instalador, tus órdenes y tu manual sintéticos ya casi están listos.",
      longWait: { before: "Está tardando más de lo normal. Si no carga en un momento, ", link: "escríbenos", after: "." },
      working: "Preparando…",
    },
    ready: {
      title: "Tu mundo está listo.",
      summaryTitle: "Lo que sembramos para ti",
      operator: "Operadora",
      installers: "Instaladores",
      supervisors: "Supervisores",
      workOrders: "Órdenes del día",
      simNow: "Hora simulada",
      createdAt: "Creado el",
      expiry: (date: string) => `Tu mundo vence el ${date}; al volver a entrar se recrea.`,
    },
    stages: {
      title: "Se habilita por etapas",
      available: "Ya puedes usar",
      availableNone: "Por ahora, esta portada con el resumen de tu mundo.",
      pending: "Llega en las próximas etapas",
    },
    failed: { title: "No pudimos preparar tu mundo.", lead: "Puede ser algo temporal." },
    capFull: {
      title: "Por ahora llegamos al límite de mundos de prueba disponibles.",
      lead: "Tu cuenta ya está creada; solo falta lugar para tu mundo.",
      talk: { link: "Hablemos", after: " si quieres una demo guiada mientras tanto." },
    },
    personLimit: {
      title: "Ya tienes dos cuentas de prueba con su mundo.",
      lead: "Esta cuenta quedó creada, pero sin mundo propio: cada persona puede tener hasta dos mundos de prueba. Sigue con una de tus otras cuentas.",
      talk: { link: "Hablemos", after: " si quieres una demo guiada con más espacio." },
    },
    retry: "Reintentar",
    retrying: "Reintentando…",
    retryTooSoon: "Espera un minuto antes de volver a intentarlo.",
    retryFailed: "No pudimos reintentar ahora. Prueba de nuevo en un momento.",
    deletion: {
      open: "Borrar mi cuenta",
      title: "Borrar mi cuenta",
      warning: "Esto borra tu cuenta, tus datos de contacto y tu mundo de prueba. No se puede deshacer.",
      password: "Tu contraseña",
      passwordHint: "La pedimos para confirmar que eres tú.",
      confirm: "Borrar mi cuenta definitivamente",
      working: "Borrando…",
      cancel: "Cancelar",
      wrongPassword: "La contraseña no es correcta.",
      failed: "No pudimos borrar tu cuenta ahora. Intenta de nuevo en un momento.",
    },
    months: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    dateFormat: (day: number, month: string, year: number) => `${day} de ${month} de ${year}`,
    weekdays: { MON: "lun", TUE: "mar", WED: "mié", THU: "jue", FRI: "vie", SAT: "sáb", SUN: "dom" } satisfies Record<Weekday, string>,
    /** Titles of the console's parts; the console's own titles are the Spanish source (copy/console.ts). */
    parts: {} as Readonly<Record<string, string>>,
  },
  en: {
    htmlLang: "en",
    heading: "Your test world",
    contactUrl: CONTACT_URL,
    provisioning: {
      title: "We're setting up your test world.",
      lead: "Your synthetic installer, work orders and manual are almost ready.",
      longWait: { before: "This is taking longer than usual. If it doesn't load in a moment, ", link: "reach out", after: "." },
      working: "Setting up…",
    },
    ready: {
      title: "Your world is ready.",
      summaryTitle: "What we seeded for you",
      operator: "Operator",
      installers: "Installers",
      supervisors: "Supervisors",
      workOrders: "Work orders of the day",
      simNow: "Simulated time",
      createdAt: "Created on",
      expiry: (date: string) => `Your world expires on ${date}; it's recreated the next time you sign in.`,
    },
    stages: {
      title: "Rolling out in stages",
      available: "You can already use",
      availableNone: "For now, this page with the summary of your world.",
      pending: "Coming in the next stages",
    },
    failed: { title: "We couldn't set up your world.", lead: "This might be temporary." },
    capFull: {
      title: "We've hit the limit of test worlds available right now.",
      lead: "Your account is already created; we just need room for your world.",
      talk: { link: "Let's talk", after: " if you'd like a guided demo meanwhile." },
    },
    personLimit: {
      title: "You already have two test accounts with their worlds.",
      lead: "This account is created, but without a world of its own: each person can have up to two test worlds. Carry on with one of your other accounts.",
      talk: { link: "Let's talk", after: " if you'd like a guided demo with more room." },
    },
    retry: "Retry",
    retrying: "Retrying…",
    retryTooSoon: "Wait a minute before trying again.",
    retryFailed: "We couldn't retry right now. Try again in a moment.",
    deletion: {
      open: "Delete my account",
      title: "Delete my account",
      warning: "This deletes your account, your contact details and your test world. This can't be undone.",
      password: "Your password",
      passwordHint: "We ask for it to confirm it's you.",
      confirm: "Delete my account for good",
      working: "Deleting…",
      cancel: "Cancel",
      wrongPassword: "That password isn't right.",
      failed: "We couldn't delete your account right now. Try again in a moment.",
    },
    months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    dateFormat: (day: number, month: string, year: number) => `${month} ${day}, ${year}`,
    weekdays: { MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu", FRI: "Fri", SAT: "Sat", SUN: "Sun" } satisfies Record<Weekday, string>,
    parts: {
      orders: "Work orders of the day",
      cases: "Cases",
      evidence: "Evidence review",
      people: "Staff",
      manual: "Manual",
      simulator: "Phone simulator",
      clock: "Demo clock",
      outbox: "Outbox",
      metrics: "Metrics",
      audit: "Activity log",
    } as Readonly<Record<string, string>>,
  },
} as const;

export type GuestHomeCopy = (typeof guestHomeCopy)[GuestHomeLang];
