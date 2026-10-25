// Texts of the public landing in English, from docs/landing-spec.md §1, with the same keys as the
// Spanish ones (landing.test.ts). The phones of the walkthrough stay in Mexican Spanish, as the product
// talks to the installer; their only English caption is the gloss of the main story (story.ts).
import type { LandingCopy } from "./copy-es";

export const en: LandingCopy = {
  htmlLang: "en",
  lang: { label: "Switch the language to Spanish", switchTo: "Español", short: "ES" },
  skipToContent: "Skip to content",
  nav: { label: "Access", signIn: "Sign in", tryDemo: "Try the demo", talk: "Let's talk", newTab: "opens in a new tab" },
  hero: {
    eyebrow: "A field copilot on WhatsApp",
    title: "Every installation, closed with evidence on the first visit",
    lead: "A fiber installer works alone with busy hands. They message Cuadrilla on WhatsApp — text or a voice note — and the agent guides them with the operator's manual, checks every photo before accepting it, and brings in a supervisor when a person is needed.",
    note: "Demo environment with synthetic data, in a few minutes. Your account and your own test world are created once you confirm your email.",
    loop: {
      label: "Cuadrilla on a phone: one installation from start to finish",
      pause: "Pause animation",
      play: "Play animation",
      summary: (voiceText: string) =>
        `One installation in five moments: the installer sends a voice note ("${voiceText}"), Cuadrilla replies citing the manual's section, rejects a photo with glare, accepts the next one with ✅ and sends the certificate as a PDF.`,
    },
  },
  problem: {
    title: "The problem",
    lead: "Three everyday pains of a fiber installation operation.",
    before: "Today",
    after: "With Cuadrilla",
    items: [
      {
        title: "Doubts on site",
        before: "They call or text their crew lead and wait; if no one answers, they improvise.",
        after: "They ask on WhatsApp — text or voice note — and get the manual's answer in seconds, with the section cited.",
      },
      {
        title: "Repeat visits over bad evidence",
        before: "The job closes with blurry photos or no power reading; the certificate gets pieced together later, by hand.",
        after: "Every photo is checked on arrival, with an actionable reason if it doesn't pass (\"there's glare: tilt the phone\"), and the certificate is issued on its own from validated evidence.",
      },
      {
        title: "Escalations no one takes",
        before: "The supervisor doesn't see the message in time and the installer waits without knowing what's next.",
        after: "A timed ladder: the on-duty supervisor, a backup, and — if no one answers — an email to the zone lead.",
      },
    ],
  },
  walkthrough: {
    title: "How an installer works with Cuadrilla",
    lead: "Six moments of one installation, start to finish — watch the screen change at each step.",
    stepOf: (at: number, of: number) => `${at}/${of}`,
    order: (workOrderNumber: string) => `Order ${workOrderNumber}`,
    progress: "Scene progress",
    realLabel: "What's real",
    scenes: {
      S1: {
        title: "The conversation writes itself",
        lines: [
          "Rogelio arrives at the home and the ONU's PON light won't turn on. He sends a voice note without putting his tools down.",
          "Cuadrilla transcribes the audio, reads the ONU's status and replies with the manual's step, citing the section.",
        ],
        real: "WhatsApp (simulated in this demo with the phone simulator), Transcribe, AgentCore, Knowledge Base",
      },
      S2: {
        title: "The decision the system makes",
        lines: [
          "A policy question is answered only with what the manual says, and with its section.",
          "What the manual doesn't cover is never made up: Cuadrilla says so and offers to check with the supervisor.",
        ],
        real: "AgentCore, Knowledge Base, Guardrails",
      },
      S3: {
        title: "The photo check",
        lines: [
          "Every photo is checked on arrival, in an isolated call with deterministic checks.",
          "If it doesn't pass, it gets the 🔁 reaction and a reason that can be fixed on the spot; the next one passes with ✅.",
        ],
        real: "Bedrock (isolated validation), deterministic checks",
      },
      S4: {
        title: "The certificate and the outbox",
        lines: [
          "With the checklist complete, Rogelio taps Close installation on WhatsApp and gets the certificate as a PDF.",
          "At the same time, the certificate goes by email to the customer and to the operations mailbox; in this demo, to the mailbox simulator.",
        ],
        real: "SES, PDF generation",
      },
      S5: {
        title: "The escalation",
        lines: [
          "Three diagnosis steps with no change open a case: the on-duty supervisor gets the template with Take case and Can't.",
          "If no one takes it within 10 minutes, it moves to the backup supervisor. Héctor takes it, gets the summary and replies to Rogelio over the same WhatsApp.",
        ],
        real: "WhatsApp (simulated), Cognito; deterministic: the ladder and the bridge",
      },
      S6: {
        title: "Safety",
        lines: [
          "A message with a physical hazard is caught by a deterministic classifier, before the agent.",
          "The safety instruction is always the same text from the manual, complete and instant; the supervisor and the zone lead are alerted within seconds.",
        ],
        real: "Deterministic: the classifier and the fixed instruction; real: SES",
      },
    },
  },
  actors: {
    title: "What it does, by role",
    groups: [
      {
        actor: "Installer",
        items: [
          "Asks on WhatsApp and gets the manual's answer, cited",
          "Sees what's missing to close and why a photo was rejected",
          "Asks their supervisor for help with one button",
          "Gets their certificate on the spot",
        ],
      },
      {
        actor: "Supervisor",
        items: [
          "Gets only what needs a person, with the summary and photos",
          "Takes or passes a case with one button",
          "Replies to the installer without leaving WhatsApp",
          "Manually reviews a doubtful photo from the console",
        ],
      },
      {
        actor: "Zone lead",
        items: ["Hears about a safety risk in under a minute", "Gets by email the cases no one took", "Doesn't need WhatsApp: it reaches them by email"],
      },
      {
        actor: "Operations",
        items: ["Sees every job of the day, with its checklist and network status", "Reviews the decision log and the rules applied", "Exports the certificate and the metrics"],
      },
    ],
  },
  trust: {
    title: "What Cuadrilla never does",
    lead: "Rules guaranteed in code, not in an instruction to the model.",
    items: [
      {
        title: "It always cites its source",
        text: "Every policy or procedure answer cites the manual's section; if the manual doesn't cover it, it says so and offers to escalate — it never makes up a policy.",
      },
      { title: "A model never writes the safety instruction", text: "Facing a physical risk, the safety text is the same fixed text from the manual — the agent never drafts it." },
      {
        title: "A person decides on a doubtful photo",
        text: "Evidence review assists and can accept a photo on its own; manually approving a doubtful photo is always a person's decision, under their own login.",
      },
      { title: "It never charges or promises", text: "The agent never changes prices or offers discounts or compensation — those questions get escalated." },
      { title: "Every decision is logged", text: "Every rule applied, every message sent and why, is kept in an auditable log." },
      { title: "It only talks to the right people", text: "A message goes out only to someone with active consent and the right role — never to a number or a person outside policy." },
    ],
  },
  impact: {
    title: "Impact",
    lead: "Product goals and one pilot assumption, labelled as such: no figure is a result measured in production.",
    goal: "goal",
    assumption: "assumption",
    items: [
      { kind: "up", value: 70, prefix: "≥ ", suffix: "%", text: "of installer questions resolved without escalating, with the right section cited", source: "measured on the manual's 40-question set" },
      { kind: "cap", value: 30, prefix: "< ", suffix: " s", text: "time to the agent's first reply (text)", source: "p95 target for a text turn" },
      { kind: "up", value: 90, prefix: "≥ ", suffix: "%", text: "accuracy of the evidence-photo check against a labeled set", source: "measured on 60 labeled photos" },
      { kind: "cap", value: 60, prefix: "< ", suffix: " s", text: "from a reported hazard to the zone lead's alert", source: "safety-alert target" },
    ],
    pilot: "In a pilot we would measure 30-day repeat visits and minutes per installation against your baseline.",
  },
  video: {
    title: "One installation in three minutes",
    lead: "The installer on WhatsApp, the supervisor who takes a case and the operator's console, in one walkthrough.",
    label: "Cuadrilla video: one installation from start to finish",
    note: "The video downloads only when you play it.",
    fallback: "Download the video (MP4)",
  },
  integration: {
    title: "How it fits in",
    diagramLabel: "How Cuadrilla connects to the operation",
    diagram: {
      installer: "Installer (WhatsApp)",
      agent: "Cuadrilla (agent)",
      manual: "Operator's manual (knowledge base)",
      connectors: "Network orchestrator · Dispatch system",
      connectorsNote: "connectors on the operator's side",
      people: "Supervisor (WhatsApp) · Zone lead (email) · Console",
    },
    rows: [
      { block: "Channel", text: "WhatsApp, over AWS End User Messaging Social — the same channel the installer already uses, no new app to install; in this demo, with a phone simulator." },
      { block: "Agent", text: "An agent on Amazon Bedrock AgentCore that decides what to do with each message, always with the tools and the data of the job at hand — never blind." },
      { block: "Knowledge", text: "The operator's own procedures manual, in a dedicated knowledge base: the agent answers only from there and cites the section." },
      {
        block: "Operator connectors",
        text: "Two integrations on the operator's side: the network equipment status (to know whether the connection came online) and the work-order dispatch system (to know the day's schedule). In this demo both are simulated with synthetic data — the integration contract is real.",
      },
      { block: "Email notification", text: "Amazon SES delivers the certificate to the customer and to operations, and alerts the zone lead on a hazard." },
      { block: "Infrastructure", text: "Fully serverless on AWS: no servers to maintain, no capacity to provision ahead of time." },
      { block: "Security", text: "Each operator sees only its own data; console access is under each person's own login." },
    ],
    needs: "What your operation needs: your procedures manual, read access to ONU status and the day's work orders, a WhatsApp Business account connected through AWS End User Messaging Social, and a mailbox for the certificates.",
  },
  real: {
    title: "What's real and what's simulated",
    columns: [
      { title: "Real", text: "Every cloud service doing the work: the agent (Bedrock AgentCore), the photo check, voice transcription, email delivery, storage and sign-in." },
      {
        title: "Implemented, tried in the simulator",
        text: "WhatsApp, implemented on AWS End User Messaging Social: in your demo you try it in the console's phone simulator, which goes through the same agent, rules and message pipeline.",
      },
      { title: "Our own mocks", text: "Work-order dispatch, the network orchestrator (ONU), staff, customers and phones." },
      { title: "Data", text: "100% synthetic: every person, address, work order and manual in this demo is made up. Nothing of yours appears in any screenshot." },
    ],
    email: "SES sends real emails, addressed to a test mailbox that you see in the outbox.",
    yourTrial: "Trying the demo puts you in your own isolated world, with synthetic data no one else sees or touches.",
    staged: "Some parts of the console roll out in stages; your world shows you which ones you can already use.",
    renders: "The screens on this page are built with the product's real components and texts; they illustrate the product and are not a live session.",
  },
  gallery: {
    title: "Gallery",
    lead: "The operator's console, view by view. Tap a screen to enlarge it.",
  },
  finalCta: {
    title: "Ready to try it?",
    lead: "Create your account and step into your own test world in a few minutes.",
    todayTitle: "What you can do in your demo today",
    todayNow: ["Create your account with your email", "Step into your own test world, seeded with synthetic data", "See on your home page which parts of the console you can already use"],
    todayFull: "You'll be Rogelio on a phone simulator, Adriana on the console, and you control the world's clock; a 5-minute express tour.",
  },
  footer: { label: "Footer", privacy: "Privacy", terms: "Terms", talk: "Let's talk" },
  media: { placeholderTitle: "Capture pending from the stage run", placeholderNote: "capture pending" },
  zoom: { open: "Enlarge image", close: "Close", previous: "Previous image", next: "Next image", counter: (at: number, of: number) => `${at} of ${of}` },
};
