---
status: accepted
---

# Idiomas: español de México para el personal, inglés para los jueces

Los instaladores y supervisores hablan español de México y los jueces leen inglés. Decidimos: textos al personal, plantillas (`es_MX`), acta, emails, consola, manual y set de evaluación en **español de México** con tuteo (`packages/bff/src/copy/es-MX.ts`), con glosa fija en inglés para plantillas y textos del simulador (`copy/en-gloss.ts`); Transcribe en `es-MX` con vocabulario FTTH; landing y recorrido guiado **es/en**; README, instrucciones para jueces y submission en **inglés**; `CLAUDE.md`, `CONTEXT.md`, `docs/`, ADRs y casos de QA en **español neutro**; código y commits en **inglés**.

## Considered options

- **Todo en inglés**: el instalador no es el público de un producto en inglés.
- **Multi-idioma del personal**: fuera de alcance.

## Consequences

- La verificación de salida controla que todo saliente al personal esté en español.
- Guardrails en tier `CLASSIC` con definiciones y ejemplos de temas denegados en es-MX y en.
- Un texto tiene una sola fuente en `copy/`; el seed y los tests importan de ahí.
