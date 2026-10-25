// Registers the six `UTILITY` `es_MX` WhatsApp templates with Meta through End User Messaging Social
// (docs/architecture-integrations.md §4.5, docs/pending.md P-01 step 8). Their texts have one source,
// packages/bff/src/copy/templates.ts (none names the operator). Runs inside `sst shell` after P-01 steps 5
// and 6; without `--apply` it only says what it would do.
//
//   npm run channels:whatsapp-templates -- --stage poc            which templates exist and which not
//   npm run channels:whatsapp-templates -- --stage poc --apply    uploads the synthetic sample of the
//                                                                 document header, creates the missing
//                                                                 templates and records Meta's id, status
//                                                                 and category in `Reference/TEMPLATE#WHATSAPP`
//
// SDK commands, checked in the installed `@aws-sdk/client-socialmessaging` `.d.ts` before use:
// `CreateWhatsAppMessageTemplateMediaCommand {id, sourceS3File{bucketName, key}}` → `{metaHeaderHandle}`;
// `ListWhatsAppMessageTemplatesCommand {id, nextToken}` → `templates[{templateName, templateLanguage,
// metaTemplateId, templateStatus, templateCategory}]`; `CreateWhatsAppMessageTemplateCommand {id,
// templateDefinition: Uint8Array}` → `{metaTemplateId, templateStatus, category}`. The definition is
// Meta's template JSON (name, language, category, components with one example per parameter).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TemplateName } from "@cuadrilla/shared";
import { buttonTitle } from "../../packages/bff/src/copy/buttons";
import { TEMPLATES, type TemplateDefinition } from "../../packages/bff/src/copy/templates";
import { parseFlags } from "./cli-args";

export const STAGE = "poc";
export type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";

export function parseTemplatesArgs(argv: readonly string[]): { readonly apply: boolean } {
  const args: { stage?: string; apply?: boolean } = {};
  parseFlags(argv, { "--stage": (value) => void (args.stage = value()), "--apply": () => void (args.apply = true) });
  if (args.stage !== STAGE) throw new RangeError(`--stage ${STAGE} is required (the only stage)`);
  return { apply: args.apply === true };
}

/** Meta's template JSON for one of our definitions; a document header needs the handle of its sample. */
export function metaDefinition(template: TemplateDefinition, headerHandle?: string): Record<string, unknown> {
  const components: Array<Record<string, unknown>> = [];
  if (template.header !== undefined) {
    if (headerHandle === undefined) throw new RangeError(`${template.name} needs the handle of its document sample`);
    components.push({ type: "HEADER", format: template.header.format, example: { header_handle: [headerHandle] } });
  }
  components.push({ type: "BODY", text: template.body, ...(template.params.length === 0 ? {} : { example: { body_text: [template.params.map((param) => param.example)] } }) });
  if (template.buttons.length > 0) components.push({ type: "BUTTONS", buttons: template.buttons.map((action) => ({ type: "QUICK_REPLY", text: buttonTitle(action) })) });
  return { name: template.name, language: template.language, category: template.category, components };
}

/** Meta's status as the `Reference` row stores it; anything else is still under review. */
export function statusOf(remote: string | undefined): ReviewStatus {
  const upper = remote?.toUpperCase();
  return upper === "APPROVED" || upper === "REJECTED" ? upper : "PENDING";
}

export interface RemoteTemplate {
  readonly name: string;
  readonly language: string;
  readonly metaTemplateId?: string;
  readonly status?: string;
  readonly category?: string;
}

export interface TemplatesDeps {
  list(wabaId: string): Promise<RemoteTemplate[]>;
  /** Uploads `Seed/<key>` as a header sample; answers Meta's handle. */
  uploadSample(wabaId: string, seedKey: string): Promise<string>;
  create(wabaId: string, definition: Record<string, unknown>): Promise<{ readonly metaTemplateId?: string; readonly status?: string; readonly category?: string }>;
  record(name: TemplateName, update: { readonly status: ReviewStatus; readonly metaTemplateId?: string; readonly metaCategory?: string }): Promise<void>;
  wabaId(): string | undefined;
  report(line: string): void;
}

export async function runTemplates(args: { readonly apply: boolean }, deps: TemplatesDeps): Promise<{ readonly created: number; readonly existing: number }> {
  const wabaId = deps.wabaId();
  if (wabaId === undefined) throw new RangeError("the WhatsApp secrets hold the placeholder value, so there is no linked number to use: run docs/pending.md P-01 steps 5 and 6 first");
  const remote = await deps.list(wabaId);
  let created = 0;
  let existing = 0;
  let headerHandle: string | undefined;
  for (const template of Object.values(TEMPLATES)) {
    const found = remote.find((entry) => entry.name === template.name && entry.language === template.language);
    if (found !== undefined) {
      existing += 1;
      deps.report(`${template.name}: exists (${found.status ?? "unknown status"})`);
      if (args.apply) await deps.record(template.name, { status: statusOf(found.status), ...(found.metaTemplateId === undefined ? {} : { metaTemplateId: found.metaTemplateId }), ...(found.category === undefined ? {} : { metaCategory: found.category }) });
      continue;
    }
    if (!args.apply) {
      deps.report(`${template.name}: would be created (run with --apply)`);
      continue;
    }
    if (template.header !== undefined) headerHandle ??= await deps.uploadSample(wabaId, template.header.sampleKey);
    const answer = await deps.create(wabaId, metaDefinition(template, template.header === undefined ? undefined : headerHandle));
    if (answer.category !== undefined && answer.category !== template.category) deps.report(`${template.name}: Meta categorized it ${answer.category}; adjust copy/templates.ts and repeat`);
    await deps.record(template.name, { status: statusOf(answer.status), ...(answer.metaTemplateId === undefined ? {} : { metaTemplateId: answer.metaTemplateId }), ...(answer.category === undefined ? {} : { metaCategory: answer.category }) });
    created += 1;
    deps.report(`${template.name}: created (${answer.status ?? "PENDING"})`);
  }
  return { created, existing };
}

async function stageDeps(): Promise<TemplatesDeps> {
  const sdk = await import("@aws-sdk/client-socialmessaging");
  const { whatsAppConnection } = await import("../../packages/bff/src/lib/secrets");
  const { CLIENT_TIMEOUTS, awsClientConfig } = await import("../../packages/bff/src/lib/clients");
  const { bucketName } = await import("../../packages/bff/src/lib/resource");
  const { WHATSAPP_REGION } = await import("../../packages/bff/src/channels/whatsapp/config");
  const { tableClient } = await import("../../packages/bff/src/connector/index");
  const client = new sdk.SocialMessagingClient({ region: WHATSAPP_REGION, ...awsClientConfig(CLIENT_TIMEOUTS.socialMessaging) });
  const table = tableClient();
  return {
    async list(id) {
      const templates: RemoteTemplate[] = [];
      let nextToken: string | undefined;
      do {
        const page = await client.send(new sdk.ListWhatsAppMessageTemplatesCommand({ id, nextToken }));
        for (const entry of page.templates ?? []) {
          templates.push({
            name: entry.templateName ?? "",
            language: entry.templateLanguage ?? "",
            ...(entry.metaTemplateId === undefined ? {} : { metaTemplateId: entry.metaTemplateId }),
            ...(entry.templateStatus === undefined ? {} : { status: entry.templateStatus }),
            ...(entry.templateCategory === undefined ? {} : { category: entry.templateCategory }),
          });
        }
        nextToken = page.nextToken;
      } while (nextToken);
      return templates;
    },
    async uploadSample(id, seedKey) {
      const answer = await client.send(new sdk.CreateWhatsAppMessageTemplateMediaCommand({ id, sourceS3File: { bucketName: bucketName("Seed"), key: seedKey } }));
      if (answer.metaHeaderHandle === undefined) throw new Error("Meta answered no handle for the document sample");
      return answer.metaHeaderHandle;
    },
    async create(id, definition) {
      const answer = await client.send(new sdk.CreateWhatsAppMessageTemplateCommand({ id, templateDefinition: new TextEncoder().encode(JSON.stringify(definition)) }));
      return { ...(answer.metaTemplateId === undefined ? {} : { metaTemplateId: answer.metaTemplateId }), ...(answer.templateStatus === undefined ? {} : { status: answer.templateStatus }), ...(answer.category === undefined ? {} : { category: answer.category }) };
    },
    async record(name, update) {
      // Only the template's own row, which `seed:load` wrote: never a row that does not exist.
      await table.update("Reference", { PK: "REF#TEMPLATE#WHATSAPP", SK: name }, { ...update }, new Date().toISOString(), { ifExists: true });
    },
    wabaId: () => whatsAppConnection()?.wabaId,
    report: (line) => void process.stdout.write(`channels:whatsapp-templates: ${line}\n`),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseTemplatesArgs(process.argv.slice(2));
  stageDeps()
    .then((deps) => runTemplates(args, deps))
    .catch((error: unknown) => {
      process.stderr.write(`channels:whatsapp-templates: ${error instanceof Error ? error.message : "failed"}\n`);
      process.exit(1);
    });
}
