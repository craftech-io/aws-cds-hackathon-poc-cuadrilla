// `outbox` router of the console (docs/tool-catalog.md; FL-090): every email the world sent (the
// certificate to the customer and to operations, the zone chief's alert) as it left, with its SES events.
//
//   list   newest first: kind, recipient role and masked address, subject, status, events, attachment
//   get    one email with its plain-text body and, for the certificate, a 5-minute download link
//
// The body is plain text by construction (channels/email/ renders it so); the browser never gets HTML
// nor an S3 key.
import { z } from "zod";
import { ToolError, maskEmail } from "@cuadrilla/shared";
import type { OutboundEmail } from "../domain/conversations";
import { consoleCall, inWorldTime } from "./console-ports";
import { type IspContext, ispProcedure, router } from "./trpc";

const ListInput = z.object({ limit: z.number().int().min(1).max(200).optional() }).strict().optional();
const ByMail = z.object({ mailId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();

type Ctx = Pick<IspContext, "deps" | "world" | "principal">;

function summaryOf(mail: OutboundEmail) {
  return {
    mailId: mail.mailId,
    kind: mail.kind,
    toRole: mail.toRole,
    to: maskEmail(mail.to),
    subject: mail.subject,
    status: mail.status,
    events: mail.events,
    workOrderId: mail.workOrderId ?? null,
    caseId: mail.caseId ?? null,
    hasAttachment: mail.attachment !== undefined,
    sentAtSim: mail.sentAtSim,
    sentAtReal: mail.sentAtReal,
  };
}

async function mailOf(ctx: Ctx, mailId: string): Promise<OutboundEmail> {
  const mail = await ctx.deps.connector.conversations.findMail(ctx.world.ispId, mailId);
  if (mail === undefined || mail.clockId !== ctx.world.clockId) throw new ToolError("NOT_FOUND", "email not found");
  return mail;
}

export const outboxRouter = router({
  list: ispProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const mails = await ctx.deps.connector.conversations.listOutbox(ctx.world.ispId, { descending: true, limit: input?.limit ?? 100 });
    return inWorldTime(ctx, mails.filter((mail) => mail.clockId === ctx.world.clockId).map(summaryOf));
  }),
  get: ispProcedure.input(ByMail).query(async ({ ctx, input }) => {
    const mail = await mailOf(ctx, input.mailId);
    const { ports } = consoleCall(ctx);
    const attachment =
      mail.attachment === undefined
        ? null
        : {
            fileName: mail.attachment.fileName,
            sha256: mail.attachment.sha256 ?? null,
            url: await ports.objects.presignGet({ bucket: "Evidence", key: mail.attachment.s3Key, contentType: mail.attachment.contentType, download: mail.attachment.fileName }),
          };
    return inWorldTime(ctx, { ...summaryOf(mail), from: mail.from, bodyText: mail.bodyText, attachment });
  }),
});
