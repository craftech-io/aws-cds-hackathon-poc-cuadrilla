---
status: accepted
---

# El agente se comunica solo por tools; el texto final del turno es una nota interna

Muchos turnos no son una respuesta de chat (una orden reprogramada, un caso cerrado, una validación manual) y un mismo turno puede necesitar botones, una cita y referencias estructuradas. Decidimos que **todo mensaje del agente salga por `send_whatsapp`**, con `kind` y `refs` (órdenes, citas, ítems, consejos, caso), y que el texto final del Harness sea una **nota del turno** para la consola, que nunca se envía.

## Considered options

- **Responder con el texto final del turno**: sin estructura para la política, la verificación de citas y las pruebas.
- **Mezclar**: arriesga el doble mensaje.

## Consequences

- Política, G2, verificación determinista y cita obligatoria corren en un solo pipeline, el mismo que usan los mensajes de sistema.
- Las pruebas asiertan mensajes estructurados, no redacciones.
- Los mensajes a supervisores y al jefe de zona nunca los redacta el agente: son plantillas o textos del código con el resumen verificado.
