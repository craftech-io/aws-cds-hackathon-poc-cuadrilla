---
status: accepted
---

# El provider `aws` pasa de 7.32.0 a 7.33.0 para crear el vocabulario de Transcribe en `es-MX`

El primer deploy de `poc` con el vocabulario FTTH (`infra/media.ts`, WP-21) falló antes de llamar a AWS: `aws.transcribe.Vocabulary` valida `languageCode` contra la lista de códigos del SDK de Go que trae el provider, y `aws` 7.32.0 (terraform-provider-aws v6.49, `aws-sdk-go-v2/service/transcribe` v1.55.0) no conoce `es-MX`. Amazon Transcribe publicó `es-MX` en el SDK el 2026-06-02 (`service/transcribe` v1.56.0); `aws` 7.33.0 es la primera versión del provider que lo incluye (terraform-provider-aws v6.50.0, `service/transcribe` v1.56.3). El diseño (ADR-0006, ADR-0013, `docs/architecture-integrations.md` §5) pide Transcribe en `es-MX` con vocabulario propio.

Decidimos subir el provider `aws` a **7.33.0**, el salto mínimo que acepta `es-MX`. `aws-native` sigue en 1.74.1. Las notas de 7.33.0 solo suben terraform-provider-aws a v6.50.0 y corrigen un diff del proveedor de identidad de Cognito, que el app no usa.

## Considered options

- **Transcribe en `es-US`**: el provider actual lo acepta, pero cambia la decisión de idioma de ADR-0013 y de toda la documentación.
- **Crear el vocabulario fuera del provider** (función con `aws.lambda.Invocation`): le da a un rol del app `CreateVocabulary`, que hoy solo tiene el rol de CI con su cerco (ADR-0009).
- **Subir el provider a la última versión**: arrastra meses de cambios de esquema en recursos ya creados sin necesidad.
- **Subir a 7.33.0** (elegida).

## Consequences

- `sst.config.ts`, `CLAUDE.md`, `.claude/agents/devops.md` y `docs/architecture.md` dicen `aws` 7.33.0.
- Si Transcribe no admite vocabularios propios en `es-MX`, el vocabulario queda `FAILED` y el deploy falla ahí (`infra/media.ts`), nunca en una nota de voz; la salida es un ADR nuevo, no un cambio silencioso de idioma.
