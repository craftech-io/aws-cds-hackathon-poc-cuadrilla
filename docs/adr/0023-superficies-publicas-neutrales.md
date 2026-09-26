---
status: accepted
---

# Las superficies visibles nunca nombran el concurso, y un guard de CI lo verifica

La POC publicada es un **producto para un cliente futuro** (decisión del CTO del 2026-09-26, skill `poc-landing` §1). Quien la abre (un prospecto, un partner o un evaluador) tiene que ver un producto y no una entrada a un certamen. Las reglas oficiales del concurso y su FAQ, verificadas el 2026-09-26, no exigen mencionarlo en el proyecto publicado: exigen acceso gratis para probarlo, credenciales en las instrucciones de prueba **privadas** del formulario y materiales de la submission en inglés. Hasta ahora la landing, el login, los legales y parte del código hablaban de "jurado", "judge" y del concurso. Decidimos:

1. **Ninguna superficie visible nombra el concurso ni a sus evaluadores.** Superficie visible, en este repo, es todo texto que puede leer o escuchar una persona fuera del equipo, y sus fuentes:

   | Superficie | Fuentes en el repo |
   |---|---|
   | Landing, alta, login, recuperación, consola, simulador, páginas públicas | `packages/web/src/**` (salvo tests), `packages/web/index.html`, `packages/web/public/**` (archivos de texto: HTML, JSON, SVG, TXT) |
   | Legales | `packages/web/public/legal/**` |
   | Textos al personal, plantillas de WhatsApp (y futuras de RCS/SMS), emails de producto, textos del acta, aviso de lead | `packages/bff/src/copy/**`, `packages/bff/src/certificates/**`, `packages/bff/src/leads/**` (salvo tests) |
   | Emails de autenticación (código de alta, reenvío, recuperación, invitación) | `packages/bff/src/copy/auth-emails*.ts` (trigger de mensajes de Cognito, ADR-0025) e `infra/auth-email.ts` (plantillas por defecto del pool); además, su **salida renderizada** en es y en |
   | PDF del acta y muestras | Texto de los PDFs versionados (`scripts/seed/photos/templates/*.pdf`, el acta de ejemplo de los tests) |
   | Textos del seed que ve o escucha un usuario | `scripts/seed/data/**` (manual, personas, órdenes, casos y mensajes históricos, plantillas de mundo), `scripts/seed/photos/texts.ts`, `scripts/seed/audio/texts.ts` |
   | Renders y capturas de la landing | `scripts/landing/**` (textos que dibuja), `packages/web/public/landing/**` |
| Guion de la historia principal (lo que muestran los renders de la landing y el recorrido guiado) | `packages/bff/src/story/**` (salvo tests) |
| Entradas fijas de las respuestas del modelo (el agente habla con el instalador a partir de ellas) | `packages/bff/src/agent/system-prompt.ts`, las descripciones de las tools en `infra/agent-tool-schemas.ts` y `packages/bff/src/agent-tools/*/schema.ts` |
   | README de producto | `README.md` desde el principio hasta el encabezado `## Submission notes` |
   | Build | `packages/web/dist/**` (HTML, JS, CSS, JSON, SVG) |

2. **Excepciones internas**, donde el contexto del concurso sí se nombra: `docs/**`, `CLAUDE.md`, `CONTEXT.md`, `.claude/**`, `tests/cases/**`, los tests (`*.test.ts`, `*.test.tsx`, `*.spec.ts`, `tests/**`, `packages/web/e2e/**`), la sección `## Submission notes` del final del README (y todo lo que la sigue) y los materiales de la submission, que viven fuera del repo (formulario, video, instrucciones privadas de prueba). El código fuera de las rutas de la tabla no es superficie visible, pero igual usa el vocabulario de producto (ADR-0024).

3. **Guard `npm run lint:neutral-surfaces`** (`scripts/lint/neutral-surfaces.ts`, lista en `scripts/lint/neutral-terms.ts`):
   - Recorre las fuentes de la tabla (comentarios incluidos: una fuente visible se escribe entera en vocabulario de producto) y, con `-- --dist`, el build `packages/web/dist`; con `-- --dist` y sin `dist` falla (cerrado). Los textos de `packages/shared/src/**` (salvo tests) que llegan a la web los cubre `-- --dist`.
   - Renderiza en memoria los emails de autenticación (es y en, con la marca neutral y con una de co-branding de prueba) y los recorre como texto; extrae el texto de los PDFs versionados con el mismo extractor que `lint:forbidden`.
   - Coincidencia **sin distinguir mayúsculas ni acentos** (normalización NFD sin marcas) y **por palabra completa** con la misma clase de palabra que `lint:forbidden` (letras, dígitos y `_`; el guion separa): reusa `stripAccents` y el armado del patrón de `scripts/lint/forbidden-terms.ts`, no los copia.
   - Lista (en su forma sin acentos): `hackathon`, `hackathons`, `hackaton`, `hackatones`, `devpost`, `concurso`, `concursos`, `certamen`, `certamenes`, `contest`, `contests`, `premio`, `premios`, `prize`, `prizes`, `jurado`, `jurados`, `jurada`, `juradas`, `jury`, `juries`, `juror`, `jurors`, `juez`, `jueces`, `judge`, `judges`, `judged`, `judging`, `evaluacion`, `evaluaciones`, `evaluation`, `evaluations`, `evaluador`, `evaluadores`, `evaluadora`, `evaluadoras`, `evaluator`, `evaluators`, y la frase `aws cds` (dos palabras separadas por espacios, como nombre del certamen). Los términos no son secretos: el reporte imprime archivo, línea y término.
   - Sale con código distinto de 0 ante cualquier hallazgo, en local y en CI.
   - **Tests** (`scripts/lint/neutral-surfaces.test.ts`): uno por término que falla con el término en minúsculas, en mayúsculas, con acento cuando lo lleva y dentro de una oración; negativos que pasan (`evaluar`, `prejuicio`, una palabra que contiene el término sin ser él); cada excepción de ruta (un `docs/*.md`, la sección `## Submission notes` del README, un `*.test.ts`) no reporta; un archivo de `dist` falso reporta; un email de autenticación renderizado con el término reporta; la lista del archivo es igual a la de este ADR.
   - **Cableado**: `ci.yml` lo corre en cada PR justo después de `lint:forbidden` (fuentes) y después del build de la web con `-- --dist`; `deploy.yml` igual, antes de asumir el rol de deploy. Un hallazgo corta el pipeline.
4. **Renombres de textos visibles.** Lo que hoy dice "jurado"/"judge" pasa a "invitado"/"guest" (ADR-0024). Lo que hoy dice "evaluación" en una superficie visible pasa a **"medición"** ("measurement"): las pestañas de métricas "Medición del manual" y "Medición de fotos", "set de medición". Los identificadores internos que nunca se muestran se quedan: `EV-01`, `EV-02`, `EvalResult`, `EvalSet`, relojes `eval-<runId>`, `Isp.kind EVAL`, `scripts/evaluation/`, `packages/bff/src/evaluation/` (la consola nunca muestra un id crudo, `docs/design-brief.md` §6). Un identificador de código dentro de una fuente visible que contenga un término como palabra completa (`evaluation-tab`) se renombra; uno en camelCase (`evalScore`) no coincide.
5. **README**: empieza como README de producto (qué es, cómo se prueba, qué es real y qué simulado, arquitectura, cómo se despliega en forma genérica) y termina con `## Submission notes`, única sección que nombra el concurso, la oportunidad ACE, el scaffolding declarado y los recursos con el nombre del repositorio.

6. **La landing solo muestra lo que el producto muestra.** Cada teléfono y cada recorte de consola de la landing (`docs/landing-spec.md`) reproduce una vista que existe en `docs/design-brief.md` §6, porque WP-44 lo reemplaza por una captura real de esa vista. En particular, el loop del hero (M0) y su póster con movimiento reducido muestran la nota de voz como en WhatsApp (forma de onda, duración y ✓✓ leído) y **nunca su transcripción**: quien envía una nota de voz no ve su texto y el simulador tampoco lo muestra; las transcripciones viven solo en la línea de tiempo de `/app/orders/:workOrderId`. Lo que dice la nota va únicamente en el texto `sr-only` del loop, como texto alternativo del audio.

## Considered options

- **Dejar el concurso nombrado en la landing** ("built for …"): no lo exigen las reglas y convierte el producto en una pieza de concurso ante un cliente.
- **Mostrar la transcripción bajo la burbuja de voz del hero, o en un recuadro "Consola · Orden" junto al teléfono**: la primera es una función que el producto no tiene y la captura de `/app/simulator` no coincidiría con el render; la segunda es real pero suma un segundo marco al elemento más visible de la página y compite con el H1. Elegimos lo más seguro: ninguna transcripción visible en el hero; la línea de tiempo de la orden, con sus transcripciones, ya aparece en la galería (`gallery-order-detail`).
- **Solo revisión humana**: una palabra en un texto del seed o en un email renderizado se escapa con facilidad; el guard cuesta poco y corre en cada PR.
- **Agregar las palabras a `FORBIDDEN_TERMS`**: esa lista es secreta, falla sobre todo el árbol (incluidos los docs internos, donde el concurso sí se nombra) y nunca imprime el término. Las palabras del concurso no son secretas y tienen excepciones por ruta: van en un guard propio.

## Consequences

- WP-51 crea el guard y lo cablea; WP-52, WP-53 y WP-54 dejan las fuentes visibles en verde (`docs/build-plan.md`, ola 2b.1). Desde ahí, cualquier WP que toque una fuente visible lo corre antes del PR.
- Las respuestas del modelo no pasan por el guard (se generan en runtime): el oráculo común de `docs/test-plan.md` §4.3 verifica en `SC-18` y `EV-01` que ningún saliente del agente contiene una palabra de la lista.
- `docs/test-plan.md` suma FL-120 y los tests del guard; `docs/architecture.md` §18 suma el check.
- El nombre del repositorio y del app SST contienen el nombre del concurso: nunca aparecen en una superficie visible (el dominio es `cuadrilla.demo.craftech.io`, los emails salen de ese dominio y el README de producto no los nombra antes de `## Submission notes`). Tampoco en los datos del seed: el manifiesto (`scripts/seed/data/manifest.json`) identifica el producto con `product: "cuadrilla"`, no con el nombre del app (`docs/guest-rename-map.md` §A fila 50); `scripts/seed/data/**` no tiene excepciones de ruta.
- Si una superficie nueva aparece (RCS, SMS, un email nuevo), su fuente entra en la tabla de este ADR y en `neutral-surfaces.ts` en el mismo PR.
