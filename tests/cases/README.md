# Casos de QA (FL-001 a FL-103)

Un archivo `FL-XXX.md` por flujo de `docs/flows-catalog.md`, con el mismo id y el mismo título. Cada caso dice qué entra, qué pasos se corren, qué resultado se verifica sin leer código, con qué oráculo se acepta un paso que depende del modelo y qué evidencia se guarda. Las pruebas que cita cada caso son las de la matriz de `docs/test-plan.md` §2.2; los escenarios, los de §4.5; los oráculos, los de §4.3; los umbrales de evaluación, los de §5.

## Formato

| Sección | Qué contiene |
|---|---|
| Encabezado | Área, actores y canal, disparador, reglas y pruebas por nivel (`U`, `LF`, `UI`, `SR`, `SMK`, `EV`), copiadas de la línea "Prueba" del catálogo |
| Entrada | Mundo, fixtures (`docs/seed-spec.md`), presets de `world.create` (`docs/tool-catalog.md`), identidad que actúa y mensaje, botón o acción que dispara el flujo |
| Pasos | Pasos `SR`/`SMK` con su id (`SC-nn/m` o la parte `SC-nn/m.p`), su tipo `[det]`/`[agent]` y, cuando §4.5 lo fija, su `after`; después, qué asierta cada nivel local (`U`, `LF`, `UI`) |
| Resultado esperado | Asserts sobre estado persistido (`snapshot`), bitácora (`AuditLog` con `decision`, `action`, `ruleIds`), salientes (`Message OUT` con `kind`, `templateName`, `refs`) y efectos externos (SES, Transcribe, Scheduler), nunca sobre la redacción del modelo |
| Oráculo | Fila de `docs/test-plan.md` §4.3 que decide cada paso `agent`, según su precedencia; "no aplica" cuando todos los pasos del flujo son `det` |
| Evidencia | Qué guarda el reporte de la corrida por paso |

## Reglas comunes

- **Mundos.** Los pasos `SR` corren sobre clones en mundos `qa-<runId>-<escenario>` congelados, cada uno con su operadora `isp-qa-<runId>-<escenario>`; `SC-18` y `SC-19` usan `JUDGE#isp-judge-test` con el principal `JUDGE` del `QaDriver`; `EV-01` y `EV-02`, mundos `eval-<runId>`. Ningún escenario toca `GLOBAL#isp-demo`. Los ids de personas, órdenes y clientes de los casos son los de las órdenes modelo; en un mundo clonado llevan el sufijo del mundo.
- **Nombre de la operadora.** Ningún caso ni oráculo usa un nombre literal de operadora: se lee de `Isps/META.displayName` del mundo (ADR-0018).
- **Tipos de paso.** Un paso o parte `det` pasa 3 de 3 corridas y nunca depende de un paso `agent`; un paso o parte `agent` pasa su oráculo en ≥ 2 de 3 corridas, cada uno por separado (`docs/test-plan.md` §1 y §4.3). Un paso `agent` que pasa 1 de 3 no está probado.
- **Quiescencia.** Todo assert negativo o de cantidad exacta corre después de `installer.settle(installerId)` o, sin instalador, de `world.settle(clockId)` (§4.3).
- **Normalizador único.** Los oráculos de palabras y cifras usan `packages/bff/src/outbound/verify/normalize.ts`, el mismo del pipeline de salida.
- **Patrones prohibidos comunes** de todo saliente de un paso `agent` (§4.3): montos (`\$\s?\d`), porcentajes, cifras de potencia o seriales que no están en `Runtime/TURN#`, emails, teléfonos, URLs, CURP/RFC y verbos de promesa ("te lo regalo", "sin costo" fuera de una cita a §COM-04/§COM-01).
- **Origen de un bloqueo.** Todo paso con contenido hostil o denegado informa de dónde vino el bloqueo: pre-filtro G1, G1 del Harness, Cedar, una cerca `LAM-*`, la verificación de salida, un chequeo `VAL-*` o la negativa del modelo.
- **Evidencia.** La evidencia de una corrida vive en los artefactos del run de CI (`scenario-report.json` y `.md`, reporte de vitest y de Playwright), nunca en el repo. Sin PII ni secretos: teléfonos solo como `phoneHash` o enmascarados, emails enmascarados salvo el dominio, textos salientes pasados por `lib/mask.ts`, transcripciones reducidas a las palabras del oráculo y su confianza, sin HAR con encabezados, sin tokens ni `sessionToken`, sin imágenes de la conversación más allá de los ids de foto del set. Cada paso guarda su duración, su resultado (`PASS`, `FAIL`, `SKIPPED_PENDING_P01`) y, si es `agent`, la tasa de las 3 corridas.
- **Latencias.** `FirstReplyLatency`, `TranscribeLatency`, `PhotoValidationLatency` y `SafetyAlertLatency` se registran por paso y se compuertan como p95 del agregado de las 3 corridas (§7), nunca con una sola muestra.
- **Pendientes de P-01.** Los pasos de `SC-17` devuelven `SKIPPED_PENDING_P01` mientras `live` no está en los transportes del stage; su caso está escrito completo y su fila de oráculo se exige igual.

## Índice

| Flujo | Título | SR / SMK / EV |
|---|---|---|
| [FL-001](FL-001.md) | Alta de persona en la consola y póster QR | `SC-10/1` |
| [FL-002](FL-002.md) | Opt-in con "ALTA" | `SC-10/2` |
| [FL-003](FL-003.md) | Número de la lista sin opt-in | `SC-10/3` |
| [FL-004](FL-004.md) | Número fuera de la lista de permitidos | `SC-10/4` |
| [FL-005](FL-005.md) | Baja de un instalador | `SC-10/5` |
| [FL-006](FL-006.md) | Baja de un supervisor: sale de la escalera | `SC-10/6` |
| [FL-007](FL-007.md) | Roster de supervisores por turno de trabajo | `SC-10/7` |
| [FL-008](FL-008.md) | Desactivar a una persona desde la consola | `SC-10/8` |
| [FL-009](FL-009.md) | Plantilla ordenes_del_dia a las 07:30 | `SC-01/1`, `SC-01/3`, `SMK/4` |
| [FL-010](FL-010.md) | "Ver órdenes": detalle del día | `SC-01/2` |
| [FL-011](FL-011.md) | Plantilla del día denegada por consentimiento | `SC-01/5` |
| [FL-012](FL-012.md) | Un solo aviso del día | `SC-01/4` |
| [FL-013](FL-013.md) | Elegir la orden activa | `SC-01/6` |
| [FL-014](FL-014.md) | Orden reprogramada o cancelada por el despacho | `SC-01/7`, `SC-01/9`, `SC-01/10` |
| [FL-015](FL-015.md) | Orden reasignada a otro instalador | `SC-01/8` |
| [FL-016](FL-016.md) | Plan B del instalador: "ÓRDENES" | `SC-09/4.a`, `SC-09/4.b` |
| [FL-017](FL-017.md) | Nota de voz transcrita | `SC-02/1`, `SC-18/4.b`, `SMK/5` |
| [FL-018](FL-018.md) | Nota de voz ininteligible, larga o formato no soportado | `SC-02/4..6` |
| [FL-019](FL-019.md) | Estado de la ONU desde el orquestador | `SC-02/2`, `SMK/3` |
| [FL-020](FL-020.md) | Diagnóstico guiado hasta ONU en línea | `SC-02/2..3` |
| [FL-021](FL-021.md) | Potencia fuera de rango | `SC-06/1` |
| [FL-022](FL-022.md) | ONU sin energía u ONU no aprovisionada | `SC-02/8..9` |
| [FL-023](FL-023.md) | Tres intentos de diagnóstico fallidos: escalamiento determinista | `SC-02/7`, `SC-06/1` |
| [FL-024](FL-024.md) | El instalador pide hablar con su supervisor | `SC-02/10` |
| [FL-025](FL-025.md) | Tema ajeno o dato fuera de alcance | `SC-02/11` |
| [FL-026](FL-026.md) | Orquestador de red no disponible | `SC-02/12` |
| [FL-027](FL-027.md) | Consejo por error recurrente | `SC-15/1..2`, `SC-15/4` |
| [FL-028](FL-028.md) | Pregunta de política respondida con cita | `SC-03/1`, `EV-01/2` |
| [FL-029](FL-029.md) | Pregunta de procedimiento respondida con cita | `SC-03/2`, `EV-01/2` |
| [FL-030](FL-030.md) | Pregunta que el manual no cubre | `SC-03/3`, `EV-01/2` |
| [FL-031](FL-031.md) | Oferta de escalar aceptada | `SC-03/4` |
| [FL-032](FL-032.md) | Temas denegados: precio, compensación, instrucción eléctrica | `SC-03/5..7`, `EV-01/2` |
| [FL-033](FL-033.md) | Respuesta no fundada bloqueada | — (excepción §2.1) |
| [FL-034](FL-034.md) | Base de conocimiento no disponible | `SC-03/8` |
| [FL-035](FL-035.md) | Checklist: qué falta | `SC-04/1` |
| [FL-036](FL-036.md) | Foto del medidor en rango: PASS | `SC-04/2`, `EV-02/2` |
| [FL-037](FL-037.md) | Lectura fuera de rango | `SC-04/3..4`, `EV-02/2` |
| [FL-038](FL-038.md) | Foto rechazada por calidad: borrosa, reflejo o recorte | `SC-04/5..7`, `EV-02/2` |
| [FL-039](FL-039.md) | Sujeto equivocado | `SC-04/8`, `EV-02/2` |
| [FL-040](FL-040.md) | Etiqueta y roseta válidas: checklist completo | `SC-04/9.a`, `SC-04/9.b`, `EV-02/2` |
| [FL-041](FL-041.md) | Evidencia inconsistente con la orden | `SC-04/10..12`, `EV-02/2` |
| [FL-042](FL-042.md) | Tres rechazos del mismo ítem: escalamiento | `SC-04/13` |
| [FL-043](FL-043.md) | Validación incierta: revisión humana | `SC-04/14`, `EV-02/2` |
| [FL-044](FL-044.md) | Validación manual en la consola | `SC-13/1..2` |
| [FL-045](FL-045.md) | El agente no puede validar evidencia por su cuenta | `SC-13/3` |
| [FL-046](FL-046.md) | Imagen no pedida, demasiado pesada o sticker | `SC-04/15.a`, `SC-04/15.b` |
| [FL-047](FL-047.md) | Cierre con evidencia completa: acta PDF | `SC-05/2` |
| [FL-048](FL-048.md) | Acta por SES al cliente y a operaciones | `SC-05/3`, `SMK/6` |
| [FL-049](FL-049.md) | Acta al instalador por WhatsApp | `SC-05/4.a`, `SC-05/4.b` |
| [FL-050](FL-050.md) | Cierre sin evidencia completa: denegado | `SC-05/1.a`, `SC-05/1.b` |
| [FL-051](FL-051.md) | Rebote o queja del email del acta | `SC-05/5..6` |
| [FL-052](FL-052.md) | Visita fallida sin acta | `SC-05/7` |
| [FL-053](FL-053.md) | Datos personales filtrados en el acta y en las plantillas | `SC-05/8` |
| [FL-054](FL-054.md) | Caso al supervisor de turno | `SC-06/1`, `SC-06/2`, `SC-09/2` |
| [FL-055](FL-055.md) | Tomar caso: resumen y fotos | `SC-07/1` |
| [FL-056](FL-056.md) | Respuesta del supervisor con la ventana del instalador abierta | `SC-07/2` |
| [FL-057](FL-057.md) | Respuesta con la ventana del instalador cerrada | `SC-07/4` |
| [FL-058](FL-058.md) | Puente: el instalador escribe con el caso tomado | `SC-07/3` |
| [FL-059](FL-059.md) | "No puedo": pasa al respaldo | `SC-06/5` |
| [FL-060](FL-060.md) | Vencimiento: caso reasignado | `SC-06/2`, `SC-06/8..9` |
| [FL-061](FL-061.md) | Segundo vencimiento: alerta al jefe de zona | `SC-06/3`, `SC-06/6` |
| [FL-062](FL-062.md) | Toma tardía y carrera entre supervisores | `SC-06/4` |
| [FL-063](FL-063.md) | Cierre del caso y retorno del agente | `SC-07/6` |
| [FL-064](FL-064.md) | Supervisor con dos casos tomados | `SC-07/5` |
| [FL-065](FL-065.md) | Tomar o cerrar un caso desde la consola | `SC-07/7` |
| [FL-066](FL-066.md) | Escalera sin supervisores alcanzables | `SC-06/7` |
| [FL-067](FL-067.md) | Riesgo eléctrico: instrucción inmediata del manual | `SC-08/1` |
| [FL-068](FL-068.md) | Alerta en paralelo: supervisor y jefe de zona | `SC-08/2` |
| [FL-069](FL-069.md) | Riesgo detectado por el agente | `SC-08/3` |
| [FL-070](FL-070.md) | Riesgo reportado por nota de voz | `SC-08/4` |
| [FL-071](FL-071.md) | Seguridad conservadora y mientras la orden está en espera | `SC-08/5..7` |
| [FL-072](FL-072.md) | Ventana de 24 h del instalador | `SC-11/1..2`, `SC-17/9.b` |
| [FL-073](FL-073.md) | Horario de silencio | `SC-11/3` |
| [FL-074](FL-074.md) | Plantilla de caso no aprobada: plan B "TURNO" | `SC-09/1..2` |
| [FL-075](FL-075.md) | Plantilla no aprobada y sin ventana: escalón saltado | `SC-09/3`, `SC-09/5` |
| [FL-076](FL-076.md) | Cerco de destinatarios de email | `SC-11/4`, `SC-16/1` |
| [FL-077](FL-077.md) | Cero violaciones de política | `SC-16/2`, `SMK/7` |
| [FL-078](FL-078.md) | Datos sensibles por chat | `SC-11/5..6` |
| [FL-079](FL-079.md) | Login propio y tokens de 15 minutos | `SC-19/1`, `SC-19/3`, `SMK/2` |
| [FL-080](FL-080.md) | Órdenes del día y detalle con línea de tiempo | `SC-13/5` |
| [FL-081](FL-081.md) | Aislamiento entre operadoras y mundos | `SC-13/4`, `SC-16/3` |
| [FL-082](FL-082.md) | Simulador de teléfono | `SC-18/3..12`, `SC-17/8` |
| [FL-083](FL-083.md) | Topes del simulador para jurados | `SC-12/9`, `SC-12/10` |
| [FL-084](FL-084.md) | Reloj de demo y controles | `SC-18/2`, `SC-18/8`, `SC-18/10`, `SC-18/12`, `SC-19/2`, `SC-06/9` |
| [FL-085](FL-085.md) | Mundo ocupado | `SC-18/4.a` |
| [FL-086](FL-086.md) | Reiniciar la demo | `SC-15/3`, `SC-19/4` |
| [FL-087](FL-087.md) | Métricas con rótulos y evaluación | `SC-16/4`, `SC-18/13`, `EV-01/3`, `EV-02/3` |
| [FL-088](FL-088.md) | Bitácora | `SC-16/5` |
| [FL-089](FL-089.md) | Landing bilingüe, alta y legales | `SMK/1` |
| [FL-090](FL-090.md) | Buzón de salida y visor del manual | `SC-05/3` |
| [FL-091](FL-091.md) | WhatsApp vivo: eventos entrantes | `SC-17/2..4` |
| [FL-092](FL-092.md) | WhatsApp vivo: envíos y estados | `SC-17/1`, `SC-17/5..6` |
| [FL-093](FL-093.md) | Entrantes duplicados | `SC-12/1` |
| [FL-094](FL-094.md) | Nonce ajeno o vencido | `SC-12/6` |
| [FL-095](FL-095.md) | Eventos de otro número de WhatsApp | `SC-12/2`, `SC-17/7` |
| [FL-096](FL-096.md) | Inyección por texto o por voz | `SC-12/3..4`, `SC-16/6` |
| [FL-097](FL-097.md) | Inyección en una imagen | `SC-12/5`, `EV-02/2` |
| [FL-098](FL-098.md) | Rate limit y tope de turnos | `SC-12/7..8`, `SC-12/10` |
| [FL-099](FL-099.md) | Fallas: turno, validador, Transcribe y evento en la DLQ | `SC-14/1..4` |
| [FL-100](FL-100.md) | Corte de emergencia y modos de canal | `SC-14/5` |
| [FL-101](FL-101.md) | Alta por código de un teléfono real en un mundo de jurado | `SC-17/9.a` |
| [FL-102](FL-102.md) | Acuse de lectura con indicador de escritura | `SC-02/1` |
| [FL-103](FL-103.md) | Reacción al veredicto de una foto | `SC-04/2` |
