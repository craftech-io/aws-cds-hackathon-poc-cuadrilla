---
status: accepted
---

# Fotos generadas por código y notas de voz generadas con Amazon Polly, con hoja de datos

No hay equipos físicos ni podemos usar fotos, audios o chats de ninguna empresa. Hace falta un set de fotos etiquetadas para validar y medir, y notas de voz en español de México para probar Transcribe de verdad. Decidimos: **fotos** renderizadas por `scripts/seed/photos/render.ts` con plantillas SVG de equipos genéricos (medidor, etiqueta de ONU, roseta) sobre fondos procedurales y degradaciones programáticas (desenfoque, reflejo, recorte, subexposición, perspectiva, compresión), con semilla fija; **voces** generadas una vez con Amazon Polly (`es-MX`, voces neurales) por el operador y codificadas a Ogg/Opus; los dos conjuntos se commitean con una **hoja de datos** que dice de dónde sale cada archivo, su `sha256` y su etiqueta.

## Considered options

- **Fotos de equipos reales tomadas por el equipo**: no tenemos equipos, y una marca real en una foto violaría la neutralidad.
- **Fondos con un modelo de imágenes de Bedrock**: posible, pero no determinista y no necesario; los fondos procedurales alcanzan para lo que se evalúa (legibilidad, reflejo, encuadre).
- **Audios grabados por el equipo**: voces de personas reales en el repo; Polly da voces sintéticas reproducibles.

## Consequences

- La precisión del validador se mide sobre imágenes más limpias que las de campo: el README lo dice y el piloto mediría con fotos reales.
- Los textos que se dibujan en las fotos (incluidas las frases adversarias) viven en un archivo que pasa por `lint:forbidden`.
- `seed:photos` y `seed:voices` son pasos aparte; `seed:validate` compara `sha256` con la hoja.
