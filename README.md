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

## Guided tour

The console's guided tour walks your demo world with the steps below (the expected simulated hours
are those of a fresh world; every step can also be reached with "Jump to scene").

<!-- TOUR:START -->
### Express tour (~5 min)

| # | Step | Button / action | What to look at | Expected wait |
|---|---|---|---|---|
| X1 | Voice → citation | Send the voice note “la ONU no prende la luz PON” (the ONU's PON light is off) (or “Jump to scene”: On site (09:20)) | Read receipt and “typing…” right away; then the transcript, the no-optical-signal state the orchestrator reports and the manual step citing §DIAG-02. | ~45 s (transcription + agent turn) |
| X2 | Rejected photo, sent again | Send the two label photos: with glare, then a good one (or “Jump to scene”: Evidence (09:45)) | 🔁 and the glare rejection with an actionable reason; ✅ on the second photo. | ~20 s per photo |
| X3 | Certificate | Tap “Cerrar instalación” (close installation) (or “Jump to scene”: Checklist complete (10:00)) | The certificate PDF in the simulator; in the outbox, the two emails (customer and operations) with their delivery event. | ~60 s (PDF + emails) |
| X4 | Safety | Send “cable pelado en el poste” (bare cable on the pole) (or “Jump to scene”: Third visit (15:10)) | The safety instruction of §SEG-01 right away, the safety alert to Adriana and the email to the zone chief in the outbox. | ~20 s |

### Full tour (~15 min)

| # | Step | Button / action | What to look at | Expected wait |
|---|---|---|---|---|
| 1 | Sign in | Open your home page | Your own world with the clock paused on Oct 13 at 07:00, the start of the day pending at 07:30 and work order 24817 pinned as the main story. | ~10 s (the first sign-in creates your world) |
| 2 | Start the day | Start the day (or “Jump to scene”: Start of the day (07:00)) | In the simulator (Rogelio), at 07:30, the orders-of-the-day template with the “Ver órdenes” (view orders) button. | ~5 s |
| 3 | View orders | Tap “Ver órdenes” as Rogelio (or “Jump to scene”: Orders of the day (07:30)) | The day's three work orders with address, plan and time window. | ~30 s (agent turn) |
| 4 | Voice note | Go to the first visit (09:20) and send the voice note (or “Jump to scene”: On site (09:20)) | Read receipt and “typing…” right away; then the transcript, the no-optical-signal state the orchestrator reports and the manual step citing §DIAG-02. | ~45 s (transcription + agent turn) |
| 5 | ONU online | Send “Ya limpié el conector, ya prende” (I cleaned the connector, it's on now) (or “Jump to scene”: Troubleshooting step given (09:25)) | The ONU online at −21.4 dBm and the request for three photos. | ~30 s (agent turn) |
| 6 | Policy question | Send “¿se cobra la roseta en otro cuarto?” (is moving the rosette to another room charged?) and open the Manual (or “Jump to scene”: ONU online (09:35)) | The answer citing §COM-04; the cited section opens in the Manual view. | ~30 s (agent turn) |
| 7 | Photos | Send the photos in order (meter, label with glare, good label, rosette) and tap “Cliente conforme” (customer sign-off) (or “Jump to scene”: Evidence (09:45)) | The ✅ and 🔁 reactions, the glare rejection with its reason and the complete checklist in the order detail. | ~20 s per photo |
| 8 | Certificate | Tap “Cerrar instalación” (close installation) and open the outbox (or “Jump to scene”: Checklist complete (10:00)) | The certificate PDF in the simulator; in the outbox, the two emails (customer and operations) with their delivery event. | ~60 s (PDF + emails) |
| 9 | Escalation | Go to the second visit (11:50) and send three low-power voice notes (or “Jump to scene”: Second visit (11:50)) | A case for diagnosis attempts opened at 11:50 that times out at 12:00; in the simulator (Adriana), the escalated-case template. | ~90 s (three agent turns) |
| 10 | Timeout | Advance to the next event and open Cases (or “Jump to scene”: Case with the supervisor on duty (11:50)) | At 12:00 nobody took the case: it moves to Héctor with the reassigned-case template; the ladder shows in the Cases view. | ~5 s |
| 11 | Take and reply | As Héctor: take the case, send the instruction and close the case (or “Jump to scene”: Case with the backup supervisor (12:00)) | The summary and the photos reach Héctor; his reply reaches Rogelio over the bridge, the power is fixed in the simulated orchestrator and the agent resumes. | ~10 s per action |
| 12 | Safety | Go to the third visit (15:10) and send “cable pelado en el poste” (bare cable on the pole) (or “Jump to scene”: Third visit (15:10)) | The safety instruction of §SEG-01 right away, the safety alert to Adriana and the email to the zone chief in the outbox. | ~20 s |
| 13 | Metrics | Open Metrics | The manual and photo measurements with their N and label; 0 policy violations; the decisions per rule. | Right away |
<!-- TOUR:END -->

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
