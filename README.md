# Cuadrilla · Powered by Craftech

A field copilot on WhatsApp for fiber (FTTH) installers of a Latin American ISP, built by Craftech
for the AWS CDS Agentic AI Partner Hackathon.

> This README is a placeholder while the project is being built. The full version (architecture
> diagram, what is real and what is simulated, WhatsApp usage, how to reproduce the stack, test
> instructions for judges) is written at the end of the build (`docs/build-plan.md`, wave 6).

## In one paragraph

A fiber installer works alone at the customer's home with busy hands. With Cuadrilla they send a
text or a voice note on WhatsApp (AWS End User Messaging Social; a phone simulator runs the channel
in every judge world, and live WhatsApp is enabled once the WhatsApp Business Account is connected): Amazon Transcribe (es-MX) turns the voice note
into text, an Amazon Bedrock AgentCore agent reads the work order and the ONU status from a
simulated network orchestrator, guides the diagnosis with the operator's procedures manual in a
Bedrock Knowledge Base (always citing the section, never inventing), validates every evidence photo
in an isolated multimodal call with deterministic checks, escalates through a supervisor ladder
with WhatsApp templates and timeouts (and an Amazon SES email to the zone chief), sends the manual's
fixed safety instruction the moment a hazard is reported, and issues the installation certificate
PDF by SES and WhatsApp. The deployed demo is co-branded with our design partner ("Cuadrilla for
<design partner> · Powered by Craftech"), with a visible disclaimer: the manual, policies, prices
and data are a synthetic demo and are not the partner's real policies. The brand is runtime
configuration, never part of this repository; without it, the demo falls back to a fictitious
operator.
Every policy, procedure, work order, installer and customer is invented. Business-impact figures
(repeat visits, minutes per installation) are pilot hypotheses, not measurements.

## Stack

SST v4 on AWS (`us-east-1`): Amazon Bedrock AgentCore (Harness, Gateway, Memory, Policy), Amazon
Bedrock (Claude, Guardrails, Knowledge Bases on Amazon S3 Vectors), Amazon Transcribe, Amazon SES,
AWS End User Messaging Social, Amazon EventBridge Scheduler and event bus, Amazon SQS, Amazon
DynamoDB, Amazon S3, Amazon Cognito, Amazon CloudFront. TypeScript monorepo (npm workspaces):
React 19 + Vite + Tailwind v4 console, tRPC v11 BFF on Lambda, vitest and Playwright.

## Development

```bash
npm ci
npm run lint && npm run lint:duplicates && npm run typecheck && npm test
npm run build -w packages/web
```

There is a single stage, `poc`, deployed only by CI (`.github/workflows/deploy.yml`) on a push to
`main`. The CI roles are created once by `infra/bootstrap/ci-role.yaml` (see its README).

## Scaffolding

The repository skeleton (SST and CI setup, CI bootstrap template, lint and traceability scripts,
console shell and shared components, own Cognito login, tRPC base, logging, retry and crypto
helpers, Knowledge Base and Transcribe infrastructure patterns, landing gallery, scenario-runner
pattern, agent definitions in `.claude/`) was reused from internal Craftech scaffolding created
during the hackathon period. Everything specific to this product is new.
