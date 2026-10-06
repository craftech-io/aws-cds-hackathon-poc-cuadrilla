---
status: superseded in part by ADR-0028
---

# El modelo del Harness es un parámetro, con límites que no cortan el turno y latencia medida en el stage

El instalador espera la respuesta en WhatsApp con las manos ocupadas: 30 s de silencio se leen como "no funciona". El Harness corría Claude Opus 5 (Claude Sonnet 5.5 desde ADR-0028, con el mismo comportamiento: thinking adaptativo por defecto) con thinking adaptativo activo por defecto (los tokens de thinking cuentan en `maxTokens`), `maxIterations 10` y tools que devuelven JSON. Un `maxTokens` bajo no acorta las respuestas: corta el turno en `max_tokens` antes de `send_whatsapp` y termina en `AGENT_FALLBACK` con reintentos. Decidimos:

- `HARNESS_MODEL_ID` es un parámetro (`infra/agentcore-spec.ts`), ~~por defecto `global.anthropic.claude-opus-5`~~ **reemplazado por ADR-0028: `global.anthropic.claude-sonnet-5-5` por el perfil de inferencia de la app**; cambiarlo exige una corrida de `EV-01` y de `SC-18` con el modelo nuevo (en el stage desplegado, con el OK del CTO por el gasto de Bedrock).
- `maxTokens 4096` (el valor probado en el scaffolding, cuyo spec documenta que CloudFormation lo define como tope de todas las llamadas del modelo de una invocación); el largo de la respuesta se acota con el system prompt ("≤ 4 líneas") y, si el Harness lo expone, con `effort` `low`/`medium`, nunca con un `maxTokens` chico.
- Cada `TurnNote` registra `stopReason`; ~~la métrica~~ el indicador `TurnMaxTokens` (campo de log desde ADR-0028, sin métrica ni alarma de CloudWatch) cuenta los turnos que terminan en `max_tokens` y `SMK/5` falla si ocurre.
- El instalador recibe una señal inmediata: el mensaje entrante se marca leído con indicador de escritura en cuanto se encola (FL-102).
- `FirstReplyLatency` (campo de log y del reporte del ejecutor desde ADR-0028) se informa con p50 y p95 por tipo (texto y voz) medidos en `poc` desde la ola de voz; si la p95 de voz pasa de 45 s, se evalúa Transcribe streaming antes que cambiar de modelo.

## Considered options

- **`maxTokens 1024` para acotar costo y latencia**: corta turnos con thinking; más fallbacks y reintentos, más latencia.
- **Modelo más chico fijo**: menos latencia, pero la calidad de cita y de escalamiento se mide con `EV-01`; se decide con datos.
- **Parámetro + límites holgados + medición** (elegida).

## Consequences

- WP-26 fija `maxTokens` y registra si el Harness expone `effort`; WP-32 registra `stopReason`.
- La tabla de latencias del README y de la consola muestra N, p50 y p95 con su rótulo.
