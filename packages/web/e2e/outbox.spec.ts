// FL-048, FL-061 and FL-090 in the browser (docs/test-plan.md §3, level UI): the outbox against the real
// `appRouter` of the local UI server (tests/ui-server, started for this spec's worker on a free port). A
// fresh world has sent nothing, and the real `outbox.list` says so. The seed holds no sent email and the UI
// server runs no worker that could send one, so the emails of a closed installation and of an exhausted
// ladder are the BFF's own shapes (routers/outbox.ts) answered on their way to the page: the two
// certificates with their PDF and their delivery events, the zone chief's alert, each body in plain text.
import type { Page } from "@playwright/test";
import { expectReadableScreen } from "./support/a11y";
import { expect, signIn, test } from "./support/ui-server";
import type { Route } from "@playwright/test";
import { copy as consoleCopy } from "../src/copy/console";
import { outboxCopy } from "../src/views/outbox/copy";

// One worker (and one UI server, one world) per file and project: the tests share the world in order.
test.describe.configure({ mode: "default" });

const copy = outboxCopy;

const PDF_URL = "/s3/Evidence/certificates/acta-24817.pdf?X-Amz-Expires=300";
const BODY = "Hola, Lucía:\n\nTe compartimos el acta de instalación de tu servicio.\n<b>Este texto llega tal cual, nunca como HTML</b>\n\nCuadrilla · Actas";

function mail(mailId: string, kind: string, toRole: string, subject: string, minute: number) {
  const at = (second: string) => `2026-10-20T15:${String(minute + 1).padStart(2, "0")}:${second}.000Z`;
  return {
    mailId,
    kind,
    toRole,
    to: "s***@simulator.amazonses.com",
    subject,
    status: "DELIVERED",
    events: [
      { type: "DELIVERY", atReal: at("20") },
      { type: "SEND", atReal: at("01") },
    ],
    workOrderId: "wo-24817-g07",
    caseId: null,
    hasAttachment: kind === "CERTIFICATE_EMAIL",
    sentAtSim: `2026-10-13T10:0${minute % 10}:00-06:00`,
    sentAtReal: at("00"),
  };
}

const MAILS = [
  mail("mail-alert", "ZONE_CHIEF_ALERT", "ZONE_CHIEF", "Alerta: caso sin atender en la Orden 24818", 12),
  mail("mail-ops", "CERTIFICATE_EMAIL", "OPS_MAILBOX", "Acta de instalación · Orden 24817", 6),
  mail("mail-customer", "CERTIFICATE_EMAIL", "CUSTOMER", "Tu acta de instalación · Orden 24817", 5),
];

function detailOf(mailId: string) {
  const found = MAILS.find((candidate) => candidate.mailId === mailId) ?? MAILS[0];
  return { ...found, from: "Cuadrilla · Actas <actas@example.invalid>", bodyText: BODY, attachment: found?.hasAttachment ? { fileName: "acta-24817.pdf", sha256: null, url: PDF_URL } : null };
}

/** `outbox.*` answered with the emails above (alone or in a batch); everything else goes to the server. */
async function sentEmails(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/api/") && url.pathname.includes("outbox."),
    async (route: Route) => {
      const url = new URL(route.request().url());
      const paths = url.pathname.slice("/api/".length).split(",");
      const batch = url.searchParams.get("batch") === "1";
      const inputs = JSON.parse(url.searchParams.get("input") ?? "{}") as Record<string, { mailId?: string } | undefined>;
      const response = await route.fetch();
      const body = (await response.json()) as unknown;
      const items = (Array.isArray(body) ? body : [body]) as unknown[];
      const answers = paths.map((path, index) => {
        if (path === "outbox.list") return { result: { data: MAILS } };
        if (path === "outbox.get") return { result: { data: detailOf((batch ? inputs[String(index)] : (inputs as { mailId?: string }))?.mailId ?? "") } };
        return items[index];
      });
      await route.fulfill({ response, json: batch ? answers : answers[0] });
    },
  );
}

test.describe("Buzón de salida", () => {
  test("[FL-090] a fresh world has sent no email yet, and the outbox says why it fills", async ({ page }) => {
    await signIn(page, "GUEST", "/app/outbox");
    await expect(page.getByRole("heading", { level: 1, name: consoleCopy.views.outbox.title })).toBeVisible();
    await expect(page.getByText(copy.table.empty)).toBeVisible();
    await expect(page.getByText(copy.table.emptyLead)).toBeVisible();
    await expectReadableScreen(page);
  });

  test("[FL-048] [FL-061] the certificates to the customer and to operations and the zone chief's alert, each delivered", async ({ page }) => {
    await sentEmails(page);
    await signIn(page, "SUPERVISOR", "/app/outbox");
    const table = page.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(4);
    await expect(table.getByRole("cell", { name: copy.kinds.CERTIFICATE_EMAIL ?? "", exact: true })).toHaveCount(2);
    await expect(table.getByRole("cell", { name: copy.kinds.ZONE_CHIEF_ALERT ?? "", exact: true })).toHaveCount(1);
    await expect(table.getByText("Cliente · s***@simulator.amazonses.com")).toBeVisible();
    await expect(table.getByText("Operaciones · s***@simulator.amazonses.com")).toBeVisible();
    await expect(table.getByText("Jefe de zona · s***@simulator.amazonses.com")).toBeVisible();
    await expect(table.getByRole("cell", { name: copy.statuses.DELIVERED ?? "", exact: true })).toHaveCount(3);
    await expect(table.getByText(`${copy.events.DELIVERY} · ${copy.eventCount(2)}`)).toHaveCount(3);
    await expectReadableScreen(page);
  });

  test("[FL-090] [FL-048] an email opens as it left: plain-text body, the PDF by a short-lived link, its SES events in order", async ({ page }) => {
    await sentEmails(page);
    await signIn(page, "GUEST", "/app/outbox");
    await page.getByRole("table").getByText("Tu acta de instalación · Orden 24817").click();
    const detail = page.getByRole("dialog", { name: copy.detail.title });
    await expect(detail.getByText("Cuadrilla · Actas <actas@example.invalid>")).toBeVisible();
    const body = detail.getByRole("region", { name: copy.detail.body });
    await expect(body.locator("pre")).toHaveText(BODY);
    await expect(body.locator("b")).toHaveCount(0);
    const download = detail.getByRole("link", { name: copy.detail.download });
    await expect(download).toHaveAttribute("href", PDF_URL);
    await expect(download).toHaveAttribute("download", "acta-24817.pdf");
    await expect(detail.getByText(copy.detail.downloadHint)).toBeVisible();
    const events = detail.getByRole("region", { name: copy.detail.events }).getByRole("listitem");
    await expect(events).toHaveCount(2);
    await expect(events.nth(0)).toContainText(copy.events.SEND ?? "");
    await expect(events.nth(1)).toContainText(copy.events.DELIVERY ?? "");
    await expectReadableScreen(page);
  });

  test("[FL-061] the zone chief's alert has no attachment", async ({ page }) => {
    await sentEmails(page);
    await signIn(page, "GUEST", "/app/outbox");
    await page.getByRole("table").getByText("Alerta: caso sin atender en la Orden 24818").click();
    const detail = page.getByRole("dialog", { name: copy.detail.title });
    await expect(detail.getByText(copy.kinds.ZONE_CHIEF_ALERT ?? "")).toBeVisible();
    await expect(detail.getByRole("link", { name: copy.detail.download })).toHaveCount(0);
  });
});
