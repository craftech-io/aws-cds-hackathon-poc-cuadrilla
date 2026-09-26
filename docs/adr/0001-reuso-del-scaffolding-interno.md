---
status: accepted
---

# Reusamos el scaffolding interno de Craftech creado durante la hackathon

Craftech construyó durante el período de esta hackathon dos bases internas: un repositorio con la infraestructura que cualquier agente sobre AWS necesita (SST v4, bootstrap del rol de CI con cercas por tag, nombre, path IAM y ARN; AgentCore con Harness, Gateway, Memory, Policy con permits por target y Guardrails; Knowledge Base sobre S3 Vectors; SES con cerco de destinatarios; cliente de Transcribe; login propio sobre Cognito; consola React con componentes compartidos; landing con galería; herramienta de capturas; tooling de seed; lint de tamaño y duplicados; agentes de `.claude/`) y el diseño de otra POC de la misma hackathon, con patrones más nuevos (modos de canal y simulador de teléfono, `QaDriver` y ejecutor de escenarios, reloj de demo por mundo, cola FIFO por unidad de trabajo, el agente habla solo por tools, lint de términos prohibidos, trazabilidad de flujos, control de propiedad de archivos por paquete de trabajo). Decidimos arrancar Cuadrilla **copiando y adaptando** esas bases, con el mapa exacto de `docs/reuse-map.md`. Todo lo específico de los productos anteriores (dominio, textos, marca, datos, canales que no usamos) se descarta y ningún archivo del repo nuevo lo nombra.

## Considered options

- **Escribir todo de cero**: repite semanas de trabajo ya pagado (el primer deploy del scaffolding falló cerrado siete veces antes del verde) y deja menos tiempo para lo que evalúan los jueces.
- **Fork**: arrastra historial, marca y dominio ajenos; el repo de la submission tiene que ser nuevo.
- **Copiar y adaptar archivo por archivo con un mapa** (elegida).

## Consequences

- El README declara "internal Craftech scaffolding created during the hackathon period", sin nombrar productos.
- `docs/architecture.md` §16 lista cada lección heredada; `lint:forbidden` (con la lista del operador, que incluye los nombres de los productos anteriores) verifica que nada ajeno quedó.
- Paquetes con scope `@cuadrilla/*`.
- Lo nuevo se escribe de cero: validación de fotos aislada, clasificador de seguridad, escalera y puente, acta con imágenes, orquestador de red y despacho mock, fotos sintéticas, notas de voz con Polly, evaluación del agente.
