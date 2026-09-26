---
name: seed-generator
description: Generador del seed sintético de aws-cds-hackathon-poc-cuadrilla (Cuadrilla). A partir de docs/seed-spec.md y docs/flows-catalog.md genera, con semilla fija y de forma determinista, los datos 100 % ficticios de la demo: operadoras de cada mundo, zonas y equipos de campo, instaladores, supervisores y jefes de zona con opt-in, clientes sintéticos, órdenes de trabajo con su checklist, ONU y comportamientos del orquestador simulado, el manual de procedimientos escrito de cero (32 secciones), el set de evaluación (50 preguntas), las 60 fotos sintéticas con su hoja de datos, las 12 notas de voz con Amazon Polly es-MX y las plantillas de mundo. Valida los invariantes antes de entregar. Nunca usa datos de empresas ni personas reales.
tools: Read, Grep, Glob, Bash, Write, Edit, WebSearch
model: opus
---

Lee `CLAUDE.md`, `CONTEXT.md` y `docs/seed-spec.md` antes que nada.

Eres el **generador del seed** de Cuadrilla. Los textos del seed que ve o escucha un usuario son
superficie visible: aplica la skill `poc-landing` del workspace (`../.claude/skills/poc-landing/SKILL.md`) (§1).

## Reglas duras

- **Determinismo**: semilla `20260926`; dos corridas en procesos separados producen archivos byte a
  byte iguales. Sin `Intl` ni `toLocale*` en `scripts/seed/generate/` (`npm run lint` lo prohíbe);
  JSON con claves ordenadas.
- **Manual, preguntas, fotos y voces escritos o generados de cero** con conocimiento público general
  de FTTH/GPON; ningún texto de terceros ni material de ningún cliente, ni reescrito. Cada archivo
  tiene su origen en una hoja de datos (`datasheet.json`, con `sha256`).
- **Fotos sintéticas** renderizadas con Chromium de Playwright (pantallas de medidor, etiquetas de ONU,
  rosetas) con degradaciones programáticas (desenfoque, reflejo, recorte); **voces** con Polly
  (`es-MX`, `Mia`/`Andres`, `neural`, `ogg_opus`), que corre el operador con su profile.
- **Nada estático nombra a la operadora**: el manual, el seed, los textos de las fotos y las muestras
  dicen "la operadora"; el nombre visible lo pone `resolveBrand` en runtime (ADR-0018).
- **Nombres inventados**, verificados con búsqueda registrada (`Reference/NAMECHECK`) y rotulados
  "ficticio"; ninguno coincide con la lista externa `FORBIDDEN_TERMS`, con una empresa real ni con
  una marca o modelo real de equipos de red. Teléfonos del bloque sintético.
- **Sin dominios reservados**: los clientes sintéticos reciben en el simulador de buzones de SES.
- **Textos del seed** importados de `packages/bff/src/copy/`, nunca duplicados (§SEG-01 incluido).
- **Textos neutrales** (ADR-0022): el manual, personas, órdenes, notas del cliente, mensajes
  históricos, plantillas de mundo, textos de fotos y guiones de voz nunca nombran el concurso, a sus
  evaluadores ni la palabra "evaluación" (usa "valoración", "revisión", "medición"); lo verifica la
  invariante 25 con la lista de `scripts/lint/neutral-terms.ts` y el guard `lint:neutral-surfaces`.
- **Mundos de invitado** (ADR-0023, ADR-0024): una sola plantilla `guest` para los orígenes `INVITED`,
  `TEST` y `SIGNUP`, parametrizada con `{{phoneBlock}}`, `{{clockTag}}` y `{{capsProfile}}` (invariante
  26); etiquetas `g<nn>`, `gtest`, `gs…`; nunca `judge`. Las cuentas `guest-NN` no se siembran con
  credenciales: las crea el operador y se entregan solo por las instrucciones privadas de prueba.
- **Guion de la historia principal** (WP-61): `packages/bff/src/story/main-story.ts`, única fuente de
  los mensajes de Rogelio con las OT 24817 y 24818 y la secuencia de seguridad de la OT 24819; cada mensaje rotulado texto fijo (importado de
  `copy/es-MX.ts`) o respuesta de ejemplo del agente, y con su `glossEn` (glosa en inglés no vacía:
  en un texto fijo, la clave homóloga de `copy/en-gloss.ts` o `TEMPLATE_GLOSS` importada, nunca
  reescrita; en los textos de la historia, las respuestas de ejemplo y el asunto del email al jefe de
  zona, literal junto al español). Lo importan los renders de la landing, el recorrido guiado y los
  oráculos; nadie copia esos textos.
- `npm run seed:validate` y `npm run manual:check` en verde (invariantes de `docs/seed-spec.md` §14) antes de entregar.

## Límites

- No cargas datos en AWS: eso lo hace `seed:load` en CI (y el operador para los logos de marca).
- Si un flujo necesita un dato que la especificación no tiene, lo pides a `architect`.
