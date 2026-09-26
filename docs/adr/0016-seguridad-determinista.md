---
status: accepted
---

# Ante un riesgo físico, la instrucción es fija y determinista y la alerta humana sale en paralelo

"Hay un cable pelado en el poste" no puede esperar un turno del modelo ni depender de su redacción. Decidimos un **clasificador de seguridad determinista** (léxico es-MX versionado, conservador) que corre sobre todo texto y toda transcripción antes de G1 y del agente; si coincide, sale de inmediato la **instrucción fija** de §SEG-01 (una sola fuente en `copy/`, escrita literal en el manual) exenta del horario de silencio, y **en paralelo** se abre un caso `SAFETY` con la plantilla `alerta_seguridad` al supervisor y un email al jefe de zona, sin esperar vencimientos. Si el léxico no lo detecta, el agente tiene `report_safety_hazard`, que corre el mismo handler.

## Considered options

- **Que el agente detecte y responda**: latencia y redacción variables en el único caso donde no pueden variar.
- **Guardrail de Bedrock como detector**: los temas denegados bloquean, no disparan una acción; y bloquearían la instrucción.
- **Léxico determinista + tool de respaldo** (elegida).

## Consequences

- Preferimos falsos positivos: una frase ambigua se trata como riesgo y un supervisor cierra el caso.
- La orden queda en espera y el agente no guía trabajo en ella hasta que el caso se cierra.
- Un bloqueo de G1 sobre el mismo mensaje no manda la respuesta de rechazo (ya salió la instrucción).
- Meta medida: alerta entregada < 60 s.
- El corte de emergencia de costo (ADR-0019) nunca desactiva este camino: no usa modelo.
