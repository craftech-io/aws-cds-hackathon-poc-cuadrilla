# Cuadrilla · Powered by Craftech

A field copilot on WhatsApp for fiber (FTTH) installers of a Latin American ISP.

> This README is a skeleton while the product is being built. Each section is completed as the
> build closes (`docs/build-plan.md`, wave 6); the structure below is final.

## What it does

A fiber installer works alone at the customer's home with busy hands. With Cuadrilla they send a
text or a voice note on WhatsApp: Amazon Transcribe (es-MX) turns the voice note into text, an
Amazon Bedrock AgentCore agent reads the work order and the ONU status from the network
orchestrator, guides the diagnosis with the operator's procedures manual in a Bedrock Knowledge
Base (always citing the section, never inventing), validates every evidence photo in an isolated
multimodal call with deterministic checks, escalates through a supervisor ladder with WhatsApp
templates and timeouts (and an Amazon SES email to the zone chief), sends the manual's fixed safety
instruction the moment a hazard is reported, and issues the installation certificate PDF by SES and
WhatsApp. Supervisors and operations follow every order, case and decision in a web console.

Who it is for: ISPs and field-service contractors that install fiber at scale and lose time and
repeat visits to incomplete evidence, questions nobody answers on site and escalations that stall.

## Try it

1. Open the demo and choose **Try the demo**.
2. Create your account with your email (you receive a verification code), confirm it and sign in.
   Your own isolated demo world, with a synthetic crew, work orders and manual, is prepared for
   you; it lasts 7 days and is recreated the next time you sign in.
3. Follow the guided tour: the express track takes about 5 minutes (enabled in stages; your world shows what is available).

Everything you operate is synthetic: the installers, customers and phone numbers are invented,
and the emails the product sends from your world go to the Amazon SES mailbox simulator, visible in
the console outbox. To delete your account and your data, use **Delete my account** in the console.

## What is real and what is simulated

To be completed at the end of the build: which AWS services run for real in every interaction,
which systems are simulated (the network orchestrator, the dispatch system, the phone simulator
while live WhatsApp is not connected), and which figures are pilot goals rather than measurements.
Every policy, procedure, work order, installer and customer is invented. The deployed demo is
co-branded with a design partner ("Cuadrilla for <design partner> · Powered by Craftech") with a
visible disclaimer: the manual, policies, prices and data are a synthetic demo and are not the
partner's real policies. The brand is runtime configuration and never part of this repository.

## Architecture

SST v4 on AWS (`us-east-1`): Amazon Bedrock AgentCore (Harness, Gateway, Memory, Policy), Amazon
Bedrock (Claude, Guardrails, Knowledge Bases on Amazon S3 Vectors), Amazon Transcribe, Amazon SES,
AWS End User Messaging Social, Amazon EventBridge Scheduler and event bus, Amazon SQS, Amazon
DynamoDB, Amazon S3, Amazon Cognito (self sign-up with email verification), AWS WAF, Amazon
CloudFront. TypeScript monorepo (npm workspaces): React 19 + Vite + Tailwind v4 console and landing,
tRPC v11 BFF on Lambda, vitest and Playwright.

Diagram, WhatsApp usage and latency table: to be completed at the end of the build.

## Privacy

Signing up stores your email, the optional name, company and role you give, your consents, your
language and how you arrived (campaign tags and the referring site), and the dates of sign-up and
last sign-in, so that you can use the demo and, only if you agree, so that Craftech can contact you
about this solution. What you type, record or upload in your demo world is kept for a limited time,
stated in the privacy notice. See the privacy notice in the demo (`/legal/privacy.html`).

## Development

```bash
npm ci
npm run lint && npm run lint:duplicates && npm run lint:neutral-surfaces && npm run typecheck && npm test
npm run build -w packages/web
```

There is a single stage, `poc`, deployed only by CI (`.github/workflows/deploy.yml`) on a push to
`main`. The CI roles are created once by `infra/bootstrap/ci-role.yaml` (see its README).

## Submission notes

This repository is Craftech's submission to the AWS CDS Agentic AI Partner Hackathon (category and
WhatsApp usage, ACE opportunity id and test instructions are completed at the end of the build).
Credentials for the evaluation accounts are given only in the private testing instructions of the
submission form; anyone can also create an account with the sign-up.

**Scaffolding.** The repository skeleton (SST and CI setup, CI bootstrap template, lint and
traceability scripts, console shell and shared components, own Cognito login, tRPC base, logging,
retry and crypto helpers, Knowledge Base and Transcribe infrastructure patterns, landing gallery,
scenario-runner pattern, agent definitions in `.claude/`) was reused from internal Craftech
scaffolding created during the hackathon period. Everything specific to this product is new.
