---
status: accepted
---

# El manual vive en una Bedrock Knowledge Base sobre S3 Vectors y se cita por sección

El instalador pregunta de política y de procedimiento en lenguaje natural, por voz y con ruido ("¿se le cobra la roseta en el otro cuarto?"). La respuesta tiene que salir del manual de la operadora, con la sección citada, y lo que el manual no cubre no se inventa. Decidimos guardar el manual (32 secciones cortas escritas de cero) en una **Bedrock Knowledge Base con S3 Vectors** (Titan Text Embeddings v2, un archivo por sección con metadatos filtrables `sectionId`, `manualVersion`, `category`), consultarla con la tool `search_procedures` (`Retrieve`, umbral de puntaje, `coverage NONE` cuando no hay nada) y exigir la cita en código (`CP-CITATION`) además del grounding de G2.

## Considered options

- **Manual en el system prompt**: no versionable, no auditable por turno, crece con cada política.
- **Checklist estructurado devuelto entero por una tool**: sirve para 20 ítems, no para un manual de procedimientos que se consulta por síntomas y sinónimos.
- **OpenSearch Serverless**: costo mínimo por hora sin uso; S3 Vectors cobra por uso.
- **Knowledge Base sobre S3 Vectors** (elegida), el patrón ya probado del scaffolding.

## Consequences

- El vector bucket se llama `kb-aws-cds-hackathon-poc-cuadrilla-poc-manual`: S3 Vectors reserva todo nombre que empieza con `aws` (lección del scaffolding); el bootstrap cerca `bucket/kb-aws-cds-hackathon-poc-cuadrilla-*`.
- La ingesta la corre `seed:load` (operador o CI), nunca una Lambda; un manual nuevo es una versión nueva (`v002`) y el filtro por versión evita mezclar.
- La instrucción de seguridad de §SEG-01 es texto fijo de `copy/` que el generador escribe literal en el manual: la sección citada y lo que se manda son lo mismo.
- La calidad se mide con el set de evaluación (`EV-01`, ≥ 70 % con la cita correcta, 100 % de las preguntas trampa escaladas sin inventar).
