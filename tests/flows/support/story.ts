// The agent's turns of the main story (packages/bff/src/story/main-story.ts: Rogelio's orders 24817,
// 24818 and 24819 on 13/10) as scripted plans: what a model that follows the system prompt calls, in
// order, with every figure copied from a result of the same turn and every procedure cited from that
// turn's `search_procedures`. The flows and the tour's timeline use the same plans.
import { READ_ONU, citedReply, outputOf, passItem, reply, search, troubleshooting, validate } from "./agent";
import type { Plan, PlanContext, PlanSource } from "./scripted-harness";

/** "−21,4": a reading as the agent writes it (the facts check normalizes the sign and the comma). */
export function dbm(context: PlanContext): string {
  const rx = outputOf(context, "get_onu_status").rxPowerDbm;
  return typeof rx === "number" ? `${rx}`.replace(".", ",") : "";
}

/** FL-017/FL-019/FL-020: the ONU has no optical signal; the first step of §DIAG-02, pending. */
export const DIAGNOSE_NO_PON: Plan = {
  steps: [READ_ONU, search("ONU sin luz PON, sin señal óptica", "DIAG"), troubleshooting("NO_PON_LIGHT", "DIAG-02", "PENDING"), citedReply(() => "La ONU no recibe señal óptica. Limpia los conectores de la roseta y de la ONU y vuelve a conectarlos", "DIAG-02")],
  note: "Primer paso de DIAG-02 indicado.",
};

/** FL-020: after the physical action the ONU is online and in range; the step fixed, the item passed, the three photos asked. */
export const CONFIRM_ONLINE: Plan = {
  steps: [
    READ_ONU,
    troubleshooting("NO_PON_LIGHT", "DIAG-02", "FIXED"),
    { tool: "update_checklist", input: { item: "ONU_ONLINE", status: "PASSED" } },
    search("fotos de evidencia del checklist de instalación", "EVI"),
    citedReply((context) => `La ONU ya está en línea a ${dbm(context)} dBm. Mándame las tres fotos: el medidor de potencia, la etiqueta de la ONU y la roseta`, "EVI-01", {
      refs: { items: ["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"] },
    }),
  ],
  note: "ONU en línea; pedí las fotos.",
};

/** FL-028: the rosette in another room, cited from §COM-04. */
export const POLICY_ROSETTE: Plan = {
  steps: [search("la clienta quiere la roseta en otro cuarto, se le cobra la reubicación", "COM"), citedReply(() => "Mover la roseta a otro cuarto no tiene costo si son hasta 15 m de cable interior", "COM-04")],
  note: "Respondí con COM-04.",
};

const verdictOf = (context: PlanContext) => outputOf(context, "validate_install_photo");
const outOfRange = (context: PlanContext) => String(verdictOf(context).reasonCode ?? "").startsWith("OUT_OF_RANGE");
const rejected = (context: PlanContext) => verdictOf(context).verdict !== "PASS";

/**
 * One photo of the checklist: its validation, the item when it passed and a short answer. A rejection's
 * actionable reason is a procedure, so it goes out cited: §DIAG-03 for a reading out of range, §EVI-01 for
 * how to take the photo.
 */
export function photoTurn(item: string): Plan {
  const why = (context: PlanContext) => `No pude validar la foto: ${String(verdictOf(context).reasonText ?? "mándala otra vez")}`;
  return {
    steps: [
      validate(item),
      passItem(item),
      { ...reply("Foto recibida y validada."), when: (context) => !rejected(context) && item !== "ROSETTE_PHOTO" },
      // The last photo of the main story: the customer's conformity is the next item (a deterministic button).
      { ...reply("Las tres fotos quedaron validadas. Cuando la clienta esté conforme, toca el botón.", { buttons: [{ action: "CUSTOMER_OK" }] }), when: (context) => !rejected(context) && item === "ROSETTE_PHOTO" },
      { ...search("potencia fuera de rango, limpieza de conectores, empalmes y curvas", "DIAG"), when: outOfRange },
      { ...citedReply(why, "DIAG-03"), when: outOfRange },
      { ...search("cómo tomar las fotos de evidencia", "EVI"), when: (context) => rejected(context) && !outOfRange(context) },
      { ...citedReply(why, "EVI-01"), when: (context) => rejected(context) && !outOfRange(context) },
    ],
    note: `Validé la foto de ${item}.`,
  };
}

/** FL-023 (the tour's step 9): the power is still low after the step; one more failed attempt of the same symptom. */
export const LOW_POWER_ATTEMPT: Plan = {
  steps: [
    READ_ONU,
    search("potencia fuera de rango, conectores y empalmes", "DIAG"),
    troubleshooting("LOW_POWER", "DIAG-03", "NO_CHANGE"),
    citedReply((context) => `La potencia sigue en ${dbm(context)} dBm. Revisa curvaturas del drop y vuelve a limpiar los conectores`, "DIAG-03"),
  ],
  note: "Otro intento de DIAG-03 sin cambio.",
};

/** FL-063 (the tour's step 11): the case closed; the agent resumes with the next step. */
export const CASE_CLOSED_RESUME: Plan = {
  steps: [READ_ONU, reply((context) => `Ya está en ${dbm(context)} dBm. Cuando puedas, mándame la foto del medidor.`)],
  note: "Retomé después del caso.",
};

/** The agent of the main story by what the installer said (the tour runs it on the guest world). */
export function storyAgent(fallback: PlanSource): PlanSource {
  return (envelope) => {
    const said = (envelope.inbound ?? "").toLowerCase();
    if (envelope.event.type === "CASE_CLOSED") return CASE_CLOSED_RESUME;
    if (envelope.event.type !== "INSTALLER_MESSAGE") return fallback(envelope);
    if (envelope.candidateId !== undefined) return photoTurn(envelope.item ?? photoItemOf(envelope.preloaded));
    if (said.includes("luz pon")) return DIAGNOSE_NO_PON;
    if (said.includes("limpié el conector")) return CONFIRM_ONLINE;
    if (said.includes("roseta") && said.includes("cobra")) return POLICY_ROSETTE;
    if (said.includes("potencia sigue")) return LOW_POWER_ATTEMPT;
    return fallback(envelope);
  };
}

/** The first photo item still pending in the checklist the worker preloaded. */
function photoItemOf(preloaded: Readonly<Record<string, unknown>>): string {
  const items = ((preloaded.get_checklist as { items?: Array<{ item: string; status: string }> } | undefined)?.items ?? []).filter((entry) => entry.item.endsWith("_PHOTO") && entry.status !== "PASSED");
  return items[0]?.item ?? "POWER_READING_PHOTO";
}
