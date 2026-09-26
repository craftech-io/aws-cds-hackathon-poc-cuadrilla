// Target `messaging` (`ToolMessaging`, docs/tool-catalog.md, ADR-0014): the only way the agent speaks.
// One message to the installer of the session (`LAM-RECIPIENT`, Cedar `CED-WA-INSTALLER-ONLY`), through
// the outbound pipeline: bridge, contact policy, render, G2, deterministic verification, transport.
import { z } from "zod";
import { CaseId, ChecklistItem, Guardrail, ManualSectionId, PhotoItem, PolicyResult } from "@cuadrilla/shared";
import { defineTool } from "../common/definition";
import { WorkOrderRef, boundedText } from "../common/fields";

/** Buttons the agent may offer (docs/tool-catalog.md, `send_whatsapp`); titles come from copy/. */
export const AgentButtonAction = z.enum(["CONSULT_SUPERVISOR", "NO_THANKS", "CUSTOMER_OK", "CLOSE_INSTALLATION", "CHOOSE_ITEM"]);
export type AgentButtonAction = z.infer<typeof AgentButtonAction>;

/** WhatsApp reply buttons of one interactive message. */
export const MAX_AGENT_BUTTONS = 3;

/** Characters of the agent's text (docs/tool-catalog.md). */
export const REPLY_MAX_CHARS = 600;

const AgentButton = z
  .strictObject({
    action: AgentButtonAction.describe("What the button does; its title comes from the code"),
    item: PhotoItem.optional().describe("Photo item the button asks for; only with CHOOSE_ITEM"),
  })
  .refine((button) => (button.action === "CHOOSE_ITEM") === (button.item !== undefined), { message: "item goes with CHOOSE_ITEM and only with it", path: ["item"] });

export const sendWhatsappTool = defineTool({
  target: "messaging",
  name: "send_whatsapp",
  description:
    "Sends one WhatsApp message to the installer of this session; it is the only way you speak (your final text is an internal note). Short, Mexican Spanish with tú, one step at a time, up to 3 buttons. Put in refs the section ids of this turn's search_procedures you cite, the orders, items, tips and case the text talks about. Returns SENT or DEFERRED; TEMPLATE_REQUIRED means the 24-hour window is closed and nothing was sent; GROUNDING_FAIL means a claim was not backed by this turn's tool results.",
  principals: ["HARNESS"],
  args: z.strictObject({
    recipientRole: z.literal("INSTALLER").describe("Recipient of the message: the installer of the session"),
    kind: z.enum(["REPLY", "ORDERS_DETAIL"]).describe("REPLY for an answer, ORDERS_DETAIL for the detail of the day's orders"),
    text: boundedText(REPLY_MAX_CHARS, "Message text in Mexican Spanish, tú, at most 4 short lines, with the citation of every policy or procedure"),
    buttons: z.array(AgentButton).max(MAX_AGENT_BUTTONS).optional().describe("Reply buttons offered with the text"),
    refs: z
      .strictObject({
        workOrderIds: z.array(WorkOrderRef).optional().describe("Numbers of the work orders the text talks about"),
        citations: z.array(ManualSectionId).optional().describe("Section ids cited in the text, from this turn's search_procedures"),
        items: z.array(ChecklistItem).optional().describe("Checklist items the text talks about"),
        tipIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).optional().describe("tipId of the profile tips the text uses"),
        caseId: CaseId.optional().describe("Case the text talks about"),
      })
      .optional()
      .describe("Structured references of the text, checked against the session"),
  }),
  output: z.strictObject({
    messageId: z.string().optional(),
    status: z.enum(["SENT", "DEFERRED"]),
    windowState: z.enum(["OPEN", "TEMPLATE_REQUIRED"]),
    policyResult: PolicyResult,
    guardrail: Guardrail,
  }),
});

export const MESSAGING_TOOLS = [sendWhatsappTool] as const;
