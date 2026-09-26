# Catálogo de tools y handlers

Tools expuestas al Harness por AgentCore Gateway (5 targets Lambda, **12 tools**), handlers deterministas de invocación directa (no están en el Gateway), procedimientos de la consola (tRPC) y acciones del `QaDriver`. Nombres en inglés, `snake_case`. Los schemas se escriben en JSON para leer; la fuente única es zod en `packages/bff/src/agent-tools/<target>/schema.ts`, de donde `npm run tools:build-schemas` genera el `inlinePayload` de cada target.

## Convenciones

| Convención | Regla |
|---|---|
| Target | Un `GatewayTarget` y una Lambda por dominio (`packages/bff/src/agent-tools/<target>/`); nombre en el Gateway `<target>___<tool>`; todo handler pasa por `createToolHandler` (`agent-tools/common/handler.ts`) |
| Principales | `harness` (rol de ejecución del Harness; **único principal del Gateway**) · `worker` (`InstallerWorker`, por import) · `channel` (`InboundWhatsApp`, `ChannelEvents`, `FeedEvents`) · `console` (BFF con JWT: `userId`, `ispId`, `role`, `isJudge`, `authTime`) · `qa` (`QaDriver`; a los handlers de consola llega por el `appRouter` real con principales armados en el servidor (`SUPERVISOR`, `OPS` o `JUDGE`); a los targets, por invocación directa con `caller QA` solo en mundos `qa-*` y `eval-*`) · `scheduler` (`ScheduleDispatch`) |
| Sesión | Toda tool del Gateway exige `sessionToken` = `<sessionId>.<turnId>.<exp>.<HMAC>` (≤ 15 min). La Lambda carga `Runtime/SESSION#<sessionId>` y **deriva** `ispId`, `installerId`, `workOrderId`, `clockId`, `eventAtSim` y `sourceMessageId`. Ningún id del input se acepta si no pertenece al instalador de la sesión y a su día (`LAM-SCOPE` → `FORBIDDEN` + `AuditLog DENY`) |
| Invocación directa | `caller` en lugar de `sessionToken`: `{"kind": "WORKER" \| "CHANNEL" \| "CONSOLE" \| "QA" \| "SCHEDULER", "ispId", "userId", "role", "eventId", "clockId"}`. `caller` no autentica: la cerca es la política de recurso de cada Lambda y la unión zod `sessionToken` XOR `caller` (`LAM-CALLER`). Si `context.clientContext` trae las claves del Gateway de AgentCore (`bedrockAgentCoreGatewayId`, `bedrockAgentCoreToolName`), `createToolHandler` exige `sessionToken` y rechaza `caller` aunque Cedar lo permita (`agent-tools/common/handler.test.ts` con los dos contextos) |
| Corte | `createToolHandler` lee `Runtime/KILL#AGENT` (global y del mundo, caché ≤ 30 s) y devuelve `UNAVAILABLE` sin efectos mientras está activo, salvo `report_safety_hazard` (`LAM-KILL`, ADR-0019) |
| Resultados del turno | Toda tool escribe su salida (redactada) en `Runtime/TURN#<turnId>/RESULT#<tool>#<seq>` (TTL 1 h): `grounding_source` de G2 y fuente de la verificación determinista |
| Errores | Nunca lanzan: `{"ok": false, "error": {"code", "message"}}` con `code` ∈ `NOT_FOUND`, `FORBIDDEN`, `INVALID`, `CONFLICT`, `UNAVAILABLE`, `POLICY_DENIED`, `DEFERRED`, `BRIDGE_ACTIVE`, `TEMPLATE_REQUIRED`, `RECIPIENT_NOT_ALLOWED`, `GROUNDING_FAIL`, `NOT_COMPLETE`, `ON_HOLD_SAFETY`, `CAP_REACHED` |
| Fechas | ISO 8601 con zona America/Mexico_City; toda fecha de negocio es simulada; la tool devuelve además `…Text` formateado en es-MX ("hoy 11:30 a 13:30") para que el modelo copie y no calcule |
| Schemas del Gateway | Solo `type`, `properties`, `required`, `items`, `description`; los `enum` bajan a `description`; zod `.strict()` en la Lambda. Los campos que Cedar prohíbe (`override`, `decision`, `force`) se declaran como propiedades opcionales documentadas ("never set; denied by policy") y zod los rechaza con cualquier valor (`LAM-STRICT`) |
| PII | Las salidas no devuelven teléfonos, emails ni identificadores de nadie; del cliente solo el nombre de pila (ficticio), la calle y la colonia; seriales completos solo en `get_work_order`/`get_onu_status` de la orden de la sesión |
| Bitácora | Toda tool con efecto escribe `AuditLog` con `decision`, `action`, `ruleIds`, `actor = AGENT`, `refs {workOrderId, turnId, …}` |

Tipos compartidos (`packages/shared/src/enums.ts`):

```json
{
  "WorkOrderStatus": ["SCHEDULED", "IN_PROGRESS", "CLOSED", "FAILED_VISIT", "RESCHEDULED", "CANCELLED", "REASSIGNED"],
  "ChecklistItem": ["ONU_ONLINE", "POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO", "CUSTOMER_OK"],
  "ChecklistItemStatus": ["PENDING", "IN_REVIEW", "PASSED", "REJECTED", "OVERRIDDEN"],
  "OnuOperState": ["ONLINE", "OFFLINE", "LOS", "DYING_GASP", "NOT_PROVISIONED"],
  "OpticalClass": ["B+", "C+"],
  "Verdict": ["PASS", "REJECT", "UNSURE"],
  "RejectReason": ["BLURRY", "GLARE", "CROPPED", "DARK", "WRONG_SUBJECT", "OUT_OF_RANGE_LOW", "OUT_OF_RANGE_HIGH", "WRONG_WAVELENGTH", "SERIAL_MISMATCH", "READING_MISMATCH", "DUPLICATE_EVIDENCE", "UNREADABLE"],
  "Symptom": ["NO_PON_LIGHT", "LOW_POWER", "NO_POWER", "NOT_PROVISIONED", "NO_BROWSING", "OTHER"],
  "StepOutcome": ["PENDING", "FIXED", "NO_CHANGE", "WORSE"],
  "CaseKind": ["ESCALATION", "SAFETY"],
  "CaseReason": ["OUT_OF_MANUAL", "DIAGNOSIS_ATTEMPTS", "PHOTO_ATTEMPTS", "INSTALLER_ASKED", "NOT_PROVISIONED", "DENIED_TOPIC", "PROMPT_INJECTION", "SAFETY", "CERTIFICATE_UNDELIVERED", "OTHER"],
  "CaseStatus": ["OPEN", "TAKEN", "CLOSED"],
  "Rung": ["PRIMARY", "SECONDARY", "ZONE_CHIEF"],
  "RungOutcome": ["NOTIFIED", "SKIPPED", "TIMED_OUT", "DECLINED", "TAKEN"],
  "HazardCategory": ["ELECTRICAL", "POLE", "HEIGHT", "WEATHER", "ANIMAL", "THREAT", "OTHER"],
  "MessageKind": ["DAY_START", "ORDERS_DETAIL", "REPLY", "SYSTEM_NOTICE", "ORDER_CHOICE", "SAFETY_INSTRUCTION", "CASE_NOTICE", "CASE_REQUEST", "SAFETY_ALERT", "CASE_BRIEF", "CASE_TAKEN_NOTICE", "RELAY", "SUPERVISOR_REPLY_TEMPLATE", "CERTIFICATE", "CERTIFICATE_EMAIL", "ZONE_CHIEF_ALERT", "READ_ACK", "VERDICT_REACTION"],
  "WhatsAppMode": ["simulated", "live"],
  "KillScope": ["ALL", "SIMULATOR", "AGENT"],
  "BrandMode": ["neutral", "cobrand"],
  "WaButtonAction": ["VIEW_ORDERS", "TAKE_CASE", "DECLINE_CASE", "CLOSE_CASE", "VIEW_REPLY", "CHOOSE_ORDER", "CHOOSE_CASE", "CHOOSE_ITEM", "CONSULT_SUPERVISOR", "NO_THANKS", "CUSTOMER_OK", "CLOSE_INSTALLATION"],
  "TurnTrigger": ["INSTALLER_MESSAGE", "ORDERS_REQUESTED", "CASE_CLOSED", "WORK_ORDER_CHANGED", "EVIDENCE_OVERRIDDEN"],
  "TimerKind": ["DAY_START", "CASE_TIMEOUT", "DEFERRED_SEND", "CERT_RETRY"],
  "ClockMode": ["RUNNING", "PAUSED"],
  "PolicyResult": {"allowed": "boolean", "ruleIds": ["string"], "reason": "string?", "nextAllowedAt": "string?"},
  "Guardrail": {"action": "NONE | BLOCKED", "groundingScore": "number?"}
}
```

---

## Target `orders` (`ToolOrders`)

### `get_work_orders`
Determinista · lee `WorkOrders GSI1`, `People` · invocan: `harness`, `console` · sin efectos.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "day": {"type": "string", "description": "uno de: TODAY | TOMORROW (por defecto TODAY)"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "installerFirstName": "string", "dayText": "string", "workOrders": [{"workOrderNumber": "string", "status": "WorkOrderStatus", "customerFirstName": "string", "addressLine": "string", "neighborhood": "string", "plan": "string", "windowText": "string", "isActive": "boolean", "openCase": "boolean"}], "nowSimText": "string", "error": "Error"}}
```

### `get_work_order`
Determinista · lee `WorkOrders`, `Cases`, `People` (perfil medido), `Isps` (zona) · invocan: `harness`, `console`. Si llega `workOrderNumber` y es del instalador y del día, la vuelve activa (`set_active_work_order`, auditado); si no, `FORBIDDEN`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "workOrderNumber": {"type": "string", "description": "opcional; por defecto la orden activa"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "workOrder": {"workOrderNumber": "string", "status": "WorkOrderStatus", "customerFirstName": "string", "addressLine": "string", "neighborhood": "string", "plan": "string", "windowText": "string", "onuSerial": "string", "onuModel": "string", "oltPort": "string", "opticalClass": "OpticalClass", "acceptanceRange": {"minDbm": "number", "maxDbm": "number", "text": "string"}, "onHoldSafety": "boolean"},
  "checklist": [{"item": "ChecklistItem", "status": "ChecklistItemStatus", "attempts": "integer"}],
  "openCase": {"caseId": "string", "reason": "CaseReason", "status": "CaseStatus", "rung": "Rung", "takenByFirstName": "string"},
  "troubleshooting": [{"symptom": "Symptom", "stepRef": "string", "outcome": "StepOutcome"}],
  "facts": {"tips": [{"tipId": "string", "reason": "RejectReason", "count30d": "integer", "text": "string"}]},
  "error": "Error"}}
```

### `get_onu_status`
Determinista (el orquestador es externo) · `NetworkMock` por SigV4 con `X-World` · invocan: `harness`, `worker`, `console`. El serial sale de la orden de la sesión; el modelo no lo pasa.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "available": "boolean", "operState": "OnuOperState", "rxPowerDbm": "number", "txPowerDbm": "number", "inRange": "boolean", "acceptanceRangeText": "string", "oltPort": "string", "observedAtText": "string", "error": "Error"}}
```

`inRange` lo calcula el código con el rango de la zona (`docs/seed-spec.md` §8, §MED-01). Con el orquestador caído devuelve `available: false` (no `error`), para que el agente siga con el manual.

---

## Target `knowledge` (`ToolKnowledge`)

### `search_procedures`
Determinista (la recuperación es de Bedrock) · `bedrock-agent-runtime:Retrieve` sobre la Knowledge Base · invocan: `harness`, `console` (visor) · sin efectos salvo `TURN#`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "query": {"type": "string", "description": "máx. 300 caracteres, en español"}, "category": {"type": "string", "description": "opcional; uno de: GEN | SEG | INS | MED | DIAG | EVI | COM | ESC | CAL"}}, "required": ["sessionToken", "query"]},
 "output": {"ok": "boolean", "coverage": "FOUND | NONE | UNAVAILABLE", "manualVersion": "string", "passages": [{"sectionId": "string", "title": "string", "text": "string", "score": "number"}], "citationFormat": "string", "error": "Error"}}
```

Reglas: `numberOfResults 5`, filtro por `manualVersion` vigente; pasajes con puntaje < 0,35 se descartan; `text` ≤ 1.200 caracteres por pasaje; `citationFormat` = `"(Manual v1, §{sectionId})"`. `coverage NONE` → el agente dice que no está en el manual. La consulta del modelo no se registra completa en logs (se enmascara y trunca).

---

## Target `evidence` (`ToolEvidence`)

### `get_checklist`
Determinista · lee `WorkOrders/CHECK#`, `Reference/RUBRIC#` · invocan: `harness`, `console`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}}, "required": ["sessionToken"]},
 "output": {"ok": "boolean", "items": [{"item": "ChecklistItem", "label": "string", "status": "ChecklistItemStatus", "attempts": "integer", "lastRejectReason": "RejectReason", "rubricHint": "string"}], "complete": "boolean", "error": "Error"}}
```

### `validate_install_photo`
Determinista con una llamada multimodal aislada · lee `WorkOrders`, `Media`; escribe `WorkOrders/EVID#`, `VAL#`, `CHECK#` (solo `REJECTED`/`IN_REVIEW`), `Evidence/photos/` (JPEG sin metadatos); `bedrock:InvokeModel`; `NetworkMock`; reacción `VERDICT_REACTION` por el pipeline (FL-103), solo cuando la invoca `harness` · invocan: `harness`, `qa` (`tool.invoke` de `EV-02` y de `SC-04/3..8`, `SC-04/9.a`, `SC-04/10..14`: sin turno, sin reacción y nunca `CHECK# PASSED`, que solo escribe `update_checklist`).

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "candidateId": {"type": "string", "description": "id de la foto candidata del sobre"}, "item": {"type": "string", "description": "uno de: POWER_READING_PHOTO | ONU_LABEL_PHOTO | ROSETTE_PHOTO"}}, "required": ["sessionToken", "candidateId", "item"]},
 "output": {"ok": "boolean", "validationId": "string", "verdict": "Verdict", "reasonCode": "RejectReason", "reasonText": "string", "readings": {"readingDbm": "number", "wavelengthNm": "number", "serialMatches": "boolean"}, "attempts": "integer", "caseOpened": {"caseId": "string", "reason": "CaseReason"}, "error": "Error"}}
```

Pasos (`docs/design-brief.md` §5.10): corte y techo global de validaciones → chequeos previos (tipo, tamaño, `DUPLICATE_EVIDENCE` por `GSI4` `SHA#<clockId>#<worldEpoch>#<sha256>` en todo el mundo y su época, incluidas las evidencias sembradas; los presets y las escenas siembran con renders `ph-seed-*` que nunca coinciden con una foto del set, salvo `photoId` explícito) → `Converse` con la rúbrica, la única tool `record_verdict`, `toolChoice auto`, thinking adaptativo con effort bajo, `maxTokens ≥ 4096`, sin `temperature` (`docs/architecture.md` §9.6; sin `toolUse` → `UNSURE`) → zod → chequeos `VAL-RANGE`, `VAL-WAVELENGTH`, `VAL-SERIAL`, `VAL-CROSSCHECK` (±3 dB contra `get_onu_status`), `VAL-CONFIDENCE` (< 0,6 → `UNSURE`). El código solo endurece. Al tercer `REJECT` del mismo ítem abre `PHOTO_ATTEMPTS` (`open_case`). `LAM-CANDIDATE`: la candidata tiene que ser un `Message IN` de imagen del instalador de la sesión sobre esa orden. Salida del modelo (schema de `record_verdict`):

```json
{"subject": "POWER_METER | ONU_LABEL | ROSETTE | OTHER", "quality": {"focus": "OK | BLURRY", "glare": "NONE | PARTIAL | BLOCKING", "framing": "OK | CROPPED", "lighting": "OK | DARK"}, "readingDbm": "number | null", "wavelengthNm": "number | null", "serial": "string | null", "modelVerdict": "PASS | REJECT", "reasonCode": "RejectReason | null", "confidence": "number"}
```

### `update_checklist`
Determinista · escribe `WorkOrders/CHECK#`, `AuditLog` · invocan: `harness`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "item": {"type": "string", "description": "uno de: ONU_ONLINE | POWER_READING_PHOTO | ONU_LABEL_PHOTO | ROSETTE_PHOTO"}, "status": {"type": "string", "description": "uno de: PASSED | PENDING"}, "validationId": {"type": "string", "description": "obligatorio para ítems de foto"}, "override": {"type": "boolean", "description": "never set; denied by policy CED-NO-OVERRIDE"}}, "required": ["sessionToken", "item", "status"]},
 "output": {"ok": "boolean", "item": "ChecklistItem", "status": "ChecklistItemStatus", "complete": "boolean", "error": "Error"}}
```

Reglas: `LAM-EVIDENCE` (foto: `PhotoValidation PASS` de la misma orden e ítem; `ONU_ONLINE`: un `get_onu_status` `ONLINE` e `inRange` del mismo turno); `CUSTOMER_OK` no se acepta (lo pone solo el botón del instalador); `OVERRIDDEN` nunca (es de la consola).

---

## Target `messaging` (`ToolMessaging`)

La tool usa el **pipeline de salida** (`packages/bff/src/outbound/`): `LAM-BRIDGE` → política de contacto → render (texto, interactivo o plantilla) → G2 → verificación determinista (hechos, `CP-CITATION`, `CP-NO-SENSITIVE-ASK`, `CP-NO-FOREIGN-LINKS`, idioma) → transporte (EUM Social o simulado) → `Conversations` + `AuditLog` (`ALLOW` con `messageId` y reglas evaluadas). El mismo pipeline lo corren el worker (mensajes de sistema, escalera, puente, acta) y `ToolCases`. El texto final del turno del Harness nunca se envía (ADR-0014).

### `send_whatsapp`
Determinista · invocan: `harness`.

```json
{"input": {"type": "object", "properties": {
   "sessionToken": {"type": "string"},
   "recipientRole": {"type": "string", "description": "siempre INSTALLER (Cedar CED-WA-INSTALLER-ONLY)"},
   "kind": {"type": "string", "description": "uno de: REPLY | ORDERS_DETAIL"},
   "text": {"type": "string", "description": "máx. 600 caracteres, español de México, tuteo"},
   "buttons": {"type": "array", "items": {"type": "object", "properties": {"action": {"type": "string", "description": "WaButtonAction permitido al agente: CONSULT_SUPERVISOR | NO_THANKS | CUSTOMER_OK | CLOSE_INSTALLATION | CHOOSE_ITEM"}, "item": {"type": "string", "description": "solo con CHOOSE_ITEM"}}}},
   "refs": {"type": "object", "properties": {"workOrderIds": {"type": "array", "items": {"type": "string"}}, "citations": {"type": "array", "items": {"type": "string"}}, "items": {"type": "array", "items": {"type": "string"}}, "tipIds": {"type": "array", "items": {"type": "string"}}, "caseId": {"type": "string"}}}},
  "required": ["sessionToken", "recipientRole", "kind", "text"]},
 "output": {"ok": "boolean", "messageId": "string", "status": "SENT | DEFERRED", "windowState": "OPEN | TEMPLATE_REQUIRED", "policyResult": "PolicyResult", "guardrail": "Guardrail", "error": "Error"}}
```

Reglas: destinatario = teléfono del instalador de la sesión (`LAM-RECIPIENT`); fuera de la ventana → `TEMPLATE_REQUIRED` sin enviar (el agente no tiene plantillas propias); ≤ 3 botones (títulos del código en `copy/es-MX.ts`, nonce por botón); `refs.citations` tiene que ser un subconjunto de los `sectionId` devueltos por `search_procedures` en el turno; un texto con afirmaciones de política o procedimiento sin cita → `GROUNDING_FAIL` (`CP-CITATION`).

---

## Target `cases` (`ToolCases`)

### `record_troubleshooting_step`
Determinista · escribe `WorkOrders/STEP#`, `AuditLog`; puede abrir un caso · invocan: `harness`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "symptom": {"type": "string", "description": "Symptom"}, "stepRef": {"type": "string", "description": "sectionId del manual que indica el paso, p. ej. DIAG-02"}, "outcome": {"type": "string", "description": "StepOutcome"}}, "required": ["sessionToken", "symptom", "stepRef", "outcome"]},
 "output": {"ok": "boolean", "stepId": "string", "failedAttempts": "integer", "caseOpened": {"caseId": "string", "reason": "CaseReason"}, "error": "Error"}}
```

Reglas: `stepRef` tiene que ser una sección devuelta en algún turno de la sesión; `NO_CHANGE`/`WORSE` suman al conteo del síntoma; al tercero, `open_case(DIAGNOSIS_ATTEMPTS)` con el resumen verificado; `ON_HOLD_SAFETY` si la orden está en espera.

### `escalate_case`
Determinista · escribe `Cases`, `AuditLog`; notifica por la escalera · invocan: `harness` (motivos `OUT_OF_MANUAL`, `INSTALLER_ASKED`, `OTHER`).

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "reason": {"type": "string", "description": "uno de: OUT_OF_MANUAL | INSTALLER_ASKED | OTHER"}, "summary": {"type": "string", "description": "máx. 500 caracteres; hechos de la orden, sin datos personales"}, "decision": {"type": "string", "description": "never set; denied by policy CED-NO-SUPERVISOR-DECISION"}}, "required": ["sessionToken", "reason", "summary"]},
 "output": {"ok": "boolean", "caseId": "string", "existing": "boolean", "rung": "Rung", "notifiedFirstName": "string", "error": "Error"}}
```

Reglas: un caso abierto por orden y motivo (el segundo devuelve el existente); el resumen pasa por G2 (fuente: resultados de la sesión) y por el enmascarador; si no pasa, el caso se abre con un resumen fijo armado por código.

### `report_safety_hazard`
Determinista · mismo handler que el clasificador (`handle_safety`) · invocan: `harness`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "category": {"type": "string", "description": "HazardCategory"}, "summary": {"type": "string", "description": "máx. 300 caracteres"}}, "required": ["sessionToken", "category", "summary"]},
 "output": {"ok": "boolean", "caseId": "string", "instructionSent": "boolean", "error": "Error"}}
```

Efectos: `SAFETY_INSTRUCTION` (si no se mandó ya por el clasificador para el mismo mensaje), `open_case(SAFETY)` con `alerta_seguridad` y `ZONE_CHIEF_ALERT` en paralelo, orden `onHoldSafety`.

### `close_installation`
Determinista · escribe `WorkOrders`, invoca `CertificateWriter`, encola entregas · invocan: `harness`; `channel` (botón "Cerrar instalación", sin turno del agente) y `qa`.

```json
{"input": {"type": "object", "properties": {"sessionToken": {"type": "string"}, "outcome": {"type": "string", "description": "uno de: INSTALLED | FAILED_VISIT"}, "failedReason": {"type": "string", "description": "solo con FAILED_VISIT; uno de: CUSTOMER_ABSENT | ACCESS_DENIED | SAFETY_UNRESOLVED | OTHER"}, "force": {"type": "boolean", "description": "never set; denied by policy CED-NO-FORCE-CLOSE"}}, "required": ["sessionToken", "outcome"]},
 "output": {"ok": "boolean", "status": "CLOSED | FAILED_VISIT", "certificateId": "string", "sha256": "string", "deliveries": [{"to": "CUSTOMER | OPS_MAILBOX | INSTALLER", "channel": "EMAIL | WHATSAPP", "status": "QUEUED"}], "missing": ["ChecklistItem"], "error": "Error"}}
```

Reglas: `INSTALLED` exige checklist completo, ONU `ONLINE` en rango en los últimos 30 min simulados y ningún caso `SAFETY` abierto (si no, `NOT_COMPLETE` con `missing`). Si la última lectura de la ONU de la orden tiene más de 30 min simulados (o no hay ninguna), la tool **hace su propia lectura** con `get_onu_status` sobre el serial de la orden (mismo cliente `network/client.ts`, `caller` de la invocación: `CHANNEL`, `HARNESS` o `QA`) y la registra antes de decidir; solo una lectura que no da `ONLINE` en rango produce `NOT_COMPLETE` con `missing ∋ ONU_ONLINE` (`agent-tools/cases/close.test.ts`: botón sin turno y sin lectura reciente → lectura propia `ONLINE` → `CLOSED`; lectura propia `LOS` → `NOT_COMPLETE`; lectura ≤ 30 min → ninguna consulta nueva); `FAILED_VISIT` no genera acta y avisa al despacho (evento propio en la bitácora). Con `caller CHANNEL` (botón, sin turno), un `NOT_COMPLETE` lo comunica el handler del canal con el `SYSTEM_NOTICE` fijo `closeNotComplete` de `copy/` y `refs.items` = `missing` (FL-050); con `caller HARNESS`, el agente; con `caller QA`, nadie (el ejecutor lo lee de la salida).

---

## Handlers de invocación directa (no están en el Gateway)

| Handler | Principales | Qué hace | Efectos | Bitácora |
|---|---|---|---|---|
| `verify_sender` | `channel` | Antes: origen (firma SNS o `sim-envelope` de un mundo simulado) y filtro por el id de Meta del número (`docs/architecture-integrations.md` §4.4); después `PHONELEASE#<phoneHash>` o (`clockId`, `phoneHash`) → persona activa (única por `ADDR#<clockId>#…`) | `PROBE#foreign#…` en eventos ajenos | `DENY UNKNOWN_SENDER` / `FOREIGN_PHONE_NUMBER` (métrica) |
| `bind_phone_lease` | `channel` ("ALTA <código>" desde un teléfono real) | Consume `JOINCODE#` (un uso, 30 min) y crea `PHONELEASE#<phoneHash>` con `attribute_not_exists`; rechaza teléfonos del mundo vivo | `Runtime` | `PHONE_LEASE_CREATED` / `DENY LEASE_CONFLICT` |
| `acknowledge_inbound` | `channel` | Marca leído con indicador de escritura el mensaje encolado (`READ_ACK`) | Ninguno en tablas de negocio | — |
| `reserve_cost` | `worker`, `console` (simulador), `ToolEvidence` | Reserva condicional en `SIMCAP#`, `TURNCAP#` y el techo global (`…#GLOBAL#<realDay>`) antes de gastar; lee `KILL#` | `Runtime` | `CAP_REACHED` / `KILL_SWITCH_ACTIVE` |
| `set_kill_switch` | Operador (`scripts/ops/kill.ts`), `CostGuard` (solo encender), `qa` (solo `KILL#AGENT#qa-*`) | Enciende o apaga el corte | `Runtime/KILL#` | `KILL_SWITCH_SET` |
| `report_physical_action` | `worker`, `console` (mensajes rápidos del recorrido), `qa` (`network.fix`) | Avisa al orquestador simulado que el instalador actuó o que el supervisor indicó el arreglo (`docs/architecture-integrations.md` §6) | `Network` | `ACTION` |
| `record_consent` / `revoke_consent` | `channel` (ALTA/BAJA), `console`, `qa` | Opt-in con medio y versión del texto; baja con confirmación | `CONSENT#WHATSAPP` (historia) | `CONSENT_GRANTED` / `CONSENT_REVOKED` |
| `register_shift` | `channel` (TURNO) | Ventana de turno del supervisor (plan B) | `People/SHIFTWINDOW` | `SHIFT_REGISTERED` |
| `upsert_person`, `deactivate_person`, `set_roster` | `console`, `qa` | Alta y edición con `ADDR#<clockId>#<phoneHash>` condicional (único por mundo); en mundos `JUDGE`, `QA` y `EVAL` solo teléfonos del bloque sintético del mundo (`+52 55 02nn 0xxx` / `+52 55 09xx xxxx`) y emails dentro del cerco del mundo; un `CONFLICT` nunca informa sobre otro mundo; desactivación; roster por equipo y día | `People`, `Isps/ROSTER#` (historia) | `ACTION` / `DENY CONFLICT` / `DENY PHONE_NOT_SYNTHETIC` / `RECIPIENT_NOT_ALLOWED` |
| `plan_day` | `worker`, fábrica de mundos | Crea el `TIMER#DAY_START` del día para **cada instalador activo** de la lista de permitidos (con o sin órdenes, con o sin opt-in) | `TIMER#` | `ACTION` |
| `fire_day_start` | `worker`, `scheduler` | Cuenta órdenes; plantilla, denegación por política o `SKIPPED NO_WORK_ORDERS`; al final llama `plan_day(día + 1)` | `TIMER#`, `Conversations` | `ALLOW`/`DENY`/`SKIPPED` |
| `set_active_work_order` | `channel`, `harness` (vía `get_work_order`) | Orden activa o lista `ORDER_CHOICE` | `INSTSTATE#` | `ACTION` |
| `transcribe_voice_note` | `worker` | Transcribe `es-MX` con vocabulario; límites y confianza | `Message.transcript` | `ACTION TRANSCRIBED` / `LOW_CONFIDENCE` |
| `classify_safety` / `handle_safety` | `worker`, `harness` (por `report_safety_hazard`) | Léxico versionado; instrucción fija; caso `SAFETY` | `Cases`, `WorkOrders.onHoldSafety` | `SAFETY_DETECTED` con `detectedBy` |
| `open_case` | `worker`, `harness` (por tools), `channel` (botón "Consultar a mi supervisor": `OUT_OF_MANUAL` con resumen armado por código), `qa` (`case.open` y presets de `world.create`) | Crea el caso con el roster vigente y llama `advance_ladder(OPEN)` | `Cases` | `CASE_OPENED` |
| `advance_ladder` | `worker`, `scheduler` | Notifica el escalón (plantilla → plan B → salto), arma `CASE_TIMEOUT`, alerta al jefe de zona | `Cases.ladder`, `TIMER#` | `CASE_NOTIFIED` / `CASE_SKIPPED` / `CASE_TIMED_OUT` |
| `take_case` / `decline_case` / `close_case` | `channel` (botones), `console`, `qa` | Condicionales sobre `status` y `rungVersion`; `CASE_BRIEF`; puente | `Cases` | `CASE_TAKEN` / `CASE_TAKE_LOST` / `CASE_DECLINED` / `CASE_CLOSED` |
| `relay_message` / `deliver_pending_relays` | `worker` | Puente en las dos direcciones; plantilla `respuesta_supervisor` si la ventana del instalador está cerrada | `Conversations`, `Cases.bridge` | `RELAYED` |
| `record_customer_ok` | `channel` (botón `CUSTOMER_OK`) | Ítem `CUSTOMER_OK` `PASSED` | `CHECK#CUSTOMER_OK` | `ACTION` |
| `override_evidence` | `console` (`SUPERVISOR`/`JUDGE`, login ≤ 15 min), `qa` | Validación manual con motivo; encola `EVIDENCE_OVERRIDDEN` | `CHECK#` | `EVIDENCE_OVERRIDDEN` con `userId` |
| `write_certificate` | `ToolCases` (vía `CertificateWriter`) | PDF, G3, `sha256`, entregas | `CERT`, S3 | `CERTIFICATE_ISSUED` |
| `apply_email_event` | `worker` | Entregas del acta y de alertas; `CERTIFICATE_UNDELIVERED` | `Conversations`, `CERT` | `ACTION` |
| `apply_dispatch_event` | `worker` | Reprogramación, reasignación, cancelación | `WorkOrders` | `ACTION` / `DISPATCH_AFTER_CLOSE` |
| `handle_guardrail_block` | `worker` | Bloqueo de G1: respuesta fija (salvo instrucción de seguridad previa), caso, `sessionEpoch + 1` si vino del Harness | `Cases`, `Conversations` | `GUARDRAIL_BLOCK` / `GUARDRAIL_MASK` |
| `fire_timer`, `deferred_send` | `worker`, `scheduler` | Despacho por `kind`, versiones viejas ignoradas | `TIMER#` | `TIMER_FIRED` / `SKIPPED` |
| `advance_clock`, `force_case_timeout` | `console`, `qa` | `advance`, `advanceTo`, `advanceToNext`, `setMode`; vencimiento forzado; `WORLD_BUSY` desde la consola | `CLOCK#`, `TIMER#`, Scheduler | `CLOCK_ADVANCED` / `CLOCK_FORCED` |
| `set_template_status`, `set_onu_behaviour`, `dispatch_control` | `console` (controles de demo), `qa` | Estado simulado de plantillas; comportamiento de una ONU; reprogramar/reasignar/cancelar por `DispatchMock` | `Isps/SETTINGS`, `Network`, `Dispatch` | `ACTION DEMO_CONTROL` |
| `create_world`, `reset_demo_world`, `destroy_world`, `jump_to_scene` | `console` (primer login `JUDGE`, reinicio, "Saltar a escena"), `qa`, `seed:load`, `WorldJanitor` | Fábrica de mundos (capacidad `WORLDS`), épocas, tumbas, purga de Memory en pasadas, presets por operación; `whatsappMode: live` solo para el mundo de `liveWorldClockId` (singleton `LIVEWORLD`); borra los `PHONELEASE#` del mundo; reinicio, salto y destrucción de un mundo `JUDGE` conservan los contadores de tiempo real (`RATE#…#REAL#…`, `SIMCAP#`, `TURNCAP#`, `JUMP#`); `jump_to_scene` con su límite propio (30 por hora real), no el del reinicio | Todo el mundo | `WORLD_*` |
| `policy_audit` | `scheduler`, `qa` | Tres chequeos (`docs/architecture.md` §12) | `AuditLog VIOLATION` | — |

## Procedimientos de la consola (tRPC)

Todo procedimiento pasa por `ispProcedure`, salvo `brand.get`, público porque lo lee la landing (solo devuelve la marca resuelta de `BrandConfig`, sin datos de ningún mundo); **S** exige `SUPERVISOR` o `JUDGE`; **R** login ≤ 15 min.

| Router | Procedimientos |
|---|---|
| `orders` | `list` (día, equipo, estado), `get`, `timeline` (con pendientes y motivo), `mediaUrl` (GET prefirmado 5 min), `certificateUrl`, `onuStatus` |
| `cases` | `list`, `get` (escalera y puente), `take` (**S**), `close` (**S**) |
| `evidence` | `queue`, `override` (**S R**) |
| `people` | `list`, `upsert` (**S**), `deactivate` (**S**), `roster.get`, `roster.set` (**S**), `joinPoster` |
| `clock` | `get` (modo, hora, próximos eventos, `busy` y pendientes), `startDay`, `advance`, `advanceTo`, `advanceToNext`, `forceCaseTimeout`, `setRunning` (30 min), `setTemplateStatus`, `setOnuBehaviour`, `dispatch.reschedule`, `dispatch.reassign`, `dispatch.cancel` (todos con `WORLD_BUSY`), `jumpToScene` (**S**, mundos `JUDGE`; fuera del límite de reinicio, con su propio límite de 30 por hora real por mundo), `reset` (**S**, del mundo del usuario; 1 cada 10 min por mundo). Los dos, y `world.destroy` de un mundo `JUDGE`, conservan `RATE#…#REAL#…`, `SIMCAP#…`, `TURNCAP#…` y `JUMP#…` |
| `simulator` | `identities`, `thread`, `catalog` (fotos y notas de voz sintéticas con su etiqueta), `sendText`, `tapButton`, `sendVoiceNote({uploadId})`, `sendPhoto({uploadId} \| {photoId})`, `presignMedia({kind})` (registra `UPLOAD#` y devuelve el POST prefirmado), `markRead`, `quickMessages` (del recorrido; algunos llevan una acción física sobre la ONU), `joinCode` (con transporte vivo: código de alta de un solo uso para una persona del mundo), `kit` (kit del jurado) — en mundos con `whatsappMode = simulated`, dentro de los topes `SIMCAP#`, del techo global y del corte `KILL#SIMULATOR` |
| `outbox` | `list`, `get` (texto plano, adjunto por GET prefirmado) |
| `manual` | `sections`, `section` |
| `metrics` | `summary` (por pestaña, cada KPI con N, fuente y rótulo; p50 y p95; consumo del techo global y estado del corte), `export` |
| `brand` | `get` (público; modo, nombre visible de `resolveBrand`, URLs prefirmadas de los logos `onLight` y `onDark` de `Seed/brand/` o `null` para la marca de texto, aviso; ADR-0018) |
| `audit` | `list`, `violations`, `decisionsByRule` |
| `tour` | `steps({track: EXPRESS \| FULL})` (horas de "Qué mirar" desde `clock.get`, escena de cada paso, tiempo estimado del recorrido), `run(step)` (ejecuta el botón del paso por los mismos procedimientos del simulador y del reloj) |
| `account` | `session` (aviso de otra sesión para `JUDGE`), `changePassword`, `mfa.setup` (rechazados para `JUDGE`) |
| `health` | `ping` (incluye `GET /v1/health` de los dos mocks con el rol del BFF) |

## Acciones del `QaDriver`

Invocación directa del rol `qa-runner`. Cada escenario tiene su operadora (`isp-qa-<runId>-<escenario>`, `Isp.kind QA`) y su reloj `qa-<runId>-<escenario>`; cada corrida de evaluación, `isp-eval-<runId>` (`kind EVAL`) con reloj `eval-<runId>`. Así los conteos exactos (`audit.list`, `orders.list`, KPIs, buzón de salida) y los topes (`TURNCAP#<ispId>`) nunca se mezclan entre escenarios en paralelo. Toda acción que muta exige una operadora de tipo `QA` o `EVAL` **y** un `clockId` permitido, salvo la lista cerrada de `JUDGE#isp-judge-test`:

| Reloj | Acciones permitidas |
|---|---|
| `qa-*` | Todas |
| `eval-*` | `world.create`, `world.destroy`, `eval.*`, `tool.invoke`, `snapshot`, `installer.settle`, `world.settle`, `metrics.get` |
| `JUDGE#isp-judge-test` | `world.create({template: judge})`, `world.destroy`, `console.*` con el principal `JUDGE` (`console.tour.run`, `console.clock.*`, `console.simulator.*`, `console.orders.*`, `console.cases.*`, `console.evidence.*`, `console.metrics.*`, `console.account.session`), `snapshot`, `installer.settle`, `world.settle` |
| Cualquier otro | `FORBIDDEN` |

Toda acción lleva `idempotencyKey = runId/escenario/paso`; los ids que genera (`wamid.SIM.<sha256>`) salen de esa clave. Las acciones `console.*` ejecutan `appRouter.createCaller(ctx)` con un principal armado en el servidor y **siempre atado al mundo que nombra la llamada** (`{clockId}` obligatorio): `SUPERVISOR` `usr-qa-sup` u `OPS` `usr-qa-ops` de la operadora QA del escenario, o `JUDGE` `usr-qa-judge` de `isp-judge-test`; `authTime` y `sessionId` configurables (así `SC-19` arma dos sesiones distintas); los middlewares corren de verdad, incluido el límite de reinicio.

| Acción | Qué hace |
|---|---|
| `world.create` | Reloj `qa-<runId>-<escenario>` (o `eval-<runId>`) en `PAUSED` con `startAtSim`, con su operadora; o el mundo de `judge-test` con `{template: judge}`. Clones de las órdenes modelo de `Seed/worlds/models.json` con `operations: [{key, model, installer: "own" \| "<key>", preset?}]`; personas propias (teléfonos por lease `+52 55 09xx xxxx`), roster propio (dos supervisores y un jefe de zona clonados), clientes con `success+<runId>-<key>@simulator.amazonses.com` (o `bounce+`/`complaint+` si el modelo lo pide); filas de `Network` y `Dispatch`; ajustes (`rateLimitPerHour`, `demoMode`, `templateStatus`, `turnCaps`, `simulatorCaps`). **Presets por operación** (siembran estado por los mismos repositorios que el producto, nunca por turnos del modelo): `checklist: {<item>: PENDING \| PASSED \| REJECTED \| IN_REVIEW, attempts?, photoId?}` (con `PhotoValidation`, `EVID#` y evidencia sembradas con su veredicto etiquetado, marcadas `seeded: true`; sin `photoId`, cada evidencia usa un **render de siembra** `ph-seed-<item>-<nn>` distinto por orden del mundo, cuyos bytes no son los de ninguna foto del set (`docs/seed-spec.md` §10.1), así ningún paso posterior que mande una foto del set choca con `DUPLICATE_EVIDENCE`; con `photoId`, la evidencia del ítem es esa foto del set, para probar el duplicado a propósito, como `SC-04/12..13`; `attempts` siembra esa cantidad de `PhotoValidation REJECT` con renders de siembra); las escenas de "Saltar a escena" siembran igual, siempre sin `photoId`; `onu: {behaviour, rxDbm, fixed}`; `case: {reason, rung: PRIMARY \| SECONDARY \| ZONE_CHIEF, status: OPEN \| TAKEN}` (por el `open_case` real y `advance_ladder` con `caller QA`); `lastInboundAtSim` por persona (ventana de 24 h); `activeWorkOrderId`; `steps: [{symptom, stepRef, outcome}]`; `offer: {action: CONSULT_SUPERVISOR | CUSTOMER_OK | CLOSE_INSTALLATION | CHOOSE_ITEM, item?, question?}` o una lista de ellos (un `REPLY` al instalador sembrado por el repositorio de salida con ese botón y su **nonce real**, ligado a teléfono, objeto y acción como cualquier botón del agente (FL-094), etiquetado `seeded: true`; `wa.inbound button(action)` lo toca por el camino del simulador; así los botones que solo emite el agente existen en un mundo armado solo con presets); `candidates: [photoId]` (fotos candidatas registradas como mensajes del instalador, sin turno); `profile: {rejects: {<RejectReason>: n}}` (`InstallerProfile` medido sembrado por su repositorio, `seeded: true`); `globalCapsOverride` (solo `qa-*`: el mundo usa claves de techo global de prueba `…#GLOBAL#qa-<runId>#…` con los valores dados; el techo real nunca se toca) |
| `world.destroy` | Borra todo lo del mundo con condición `world IN (qa, eval)` (Memory incluida, en pasadas); deja `TOMB#` |
| `world.settle` | `{clockId, timeoutSec = 300}`: vuelve cuando `WORLDSTATE#.inFlight` está vacío, ningún temporizador del mundo está vencido y no hay emails pendientes del reloj, y lo sostiene 10 s (sirve para pasos sin instalador: número desconocido, evento ajeno, palabras clave de supervisores) |
| `case.open` | `{workOrderKey, reason, summary?}` (solo `qa-*`): llama el `open_case` real con `caller QA`; sin turno del agente |
| `clock.advance`, `clock.advanceTo`, `clock.advanceToNext`, `clock.forceCaseTimeout` | Igual que la consola, sin compuerta `WORLD_BUSY` (el ejecutor espera con `installer.settle` o `world.settle`) |
| `clock.fireTimer({timerKey})`, `clock.fireDayStart({personKey})` | Despacha un temporizador puntual (o el `DAY_START` de una persona) con `eventAtSim = simNow` (FL-012) |
| `clock.unfreeze({leadSec \| timerKey})`, `clock.freeze` | Paso de prueba del Scheduler, atómico: con el reloj en pausa fija `pausedSimNow = max(simNow, próximoTemporizador.dueAtSim − leadSec)` (por defecto 120; con `timerKey`, el vencimiento de ese temporizador; nunca mueve el reloj hacia atrás), pasa a `RUNNING` y crea los schedules; `freeze` vuelve a `PAUSED` |
| `installer.settle` | `{installerId, timeoutSec = 300}`: vuelve cuando `INSTSTATE#.inFlight` está vacío, ningún temporizador del mundo está vencido y no hay emails pendientes del reloj, y lo sostiene 10 s |
| `wa.inbound` | `{identity: <personKey> \| UNKNOWN, text \| button(action) \| voice(voiceId) \| photo(photoId) \| upload(bytes)}`: mismo camino que el simulador (sobre firmado del mundo, que tiene que ser `simulated`) |
| `wa.publishForeign` | Publica en el topic propio un evento con la forma real y un número ajeno; por código se niega a usar nuestro `WhatsAppMetaPhoneNumberId` y agrega el atributo `qa-foreign=1`, que `InboundWhatsApp` descarta siempre (FL-095) |
| `probe.foreign` | `{eventId, timeoutSec}`: espera la sonda `Runtime/PROBE#foreign#<eventId>` de `InboundWhatsApp` |
| `network.setBehaviour`, `network.fix({kind})`, `network.setFaults`, `knowledge.setFaults`, `transcribe.setFaults`, `validator.setFaults` | Comportamiento, acción física o fallas del mundo (`Runtime/FAULTS#<clockId>`, solo `qa-*`); los clientes solo leen fallas para relojes `qa-*` |
| `kill.set({scope: AGENT, on})` | Enciende o apaga `KILL#AGENT#<clockId>` del mundo del escenario (solo `qa-*`; nunca el global) |
| `dispatch.reschedule`, `dispatch.reassign`, `dispatch.cancel` | Eventos del despacho |
| `console.*` | Cualquier procedimiento del `appRouter` con el principal que pide la llamada, en el mundo que nombra |
| `mail.outcome` | `{mailId, timeoutSec}`: espera el primer evento de SES del email y lo devuelve |
| `fence.probe` | Evalúa el cerco de un mundo para una lista de direcciones, sin enviar |
| `guardrail.probe` | `ApplyGuardrail` de G1 con una cadena de ataque conocida |
| `turn.forceFailure` | Hace fallar el próximo turno de un instalador QA |
| `event.poison`, `dlq.find`, `dlq.delete`, `alarm.history` | Evento que llega a la DLQ y su limpieza (solo el del escenario) |
| `schedule.fireStale` | Despacha un temporizador con versión vieja (`rungVersion` o `version`) |
| `nonce.expire` | Vence un nonce del mundo |
| `lease.setLastInboundAtReal` | `{phoneHash, agoSec}` (solo leases de mundos `qa-*`): fija `PHONELEASE#.lastInboundAtReal` en el pasado para probar la ventana real de un teléfono ligado (`SC-17/9.b`) |
| `tool.invoke` | Invoca una Lambda target con `caller QA` en un mundo `qa-*`/`eval-*`, sin turno del agente y **sin mensaje entrante** (no toca `lastInboundAtSim`): lo usan `EV-02` y `SC-04/3..8`, `SC-04/9.a`, `SC-04/10..14` para `validate_install_photo` (sin reacción `VERDICT_REACTION` y sin `CHECK# PASSED`; oráculo: fila FL-036..FL-043 de `tool.invoke` en `docs/test-plan.md` §4.3) y `SC-05/4.b` para `close_installation` con la ventana del instalador cerrada |
| `eval.runQuestions` | `EV-01`: por pregunta del set, un **instalador propio** con una sola orden nueva activa (`operations` con `installer: own`, sin `ORDER_CHOICE` ni memoria compartida entre preguntas), `wa.inbound` de la pregunta, espera del turno; si el saliente ofrece escalar (`CONSULT_SUPERVISOR`), toca el botón y registra el caso resultante; registro de `EvalResult` (salientes, citas, casos, bloqueos, detección de seguridad, latencia, tokens) y del resultado observado contra `acceptedOutcomes` de la pregunta. Hasta 4 preguntas en paralelo (cada una en su propio grupo FIFO) |
| `eval.runPhotos` | `EV-02`: por foto del set, `tool.invoke(validate_install_photo)` sobre una orden del mundo con la clase y el serial que pide la etiqueta y la fila de `Network` sembrada con `orchestratorRxDbm`/`operState` de la hoja de datos; antes de `ph-adv-04`, siembra en la primera orden una evidencia `PASS` con el `sha256` de `ph-meter-01` (la puerta de adversarias no depende del orden ni del modelo); registro de `EvalResult` (veredicto, motivo, tokens, latencia) |
| `memory.inspect` | `{installerId, waitForExtraction?: {sentinel: {keywords}, baseline, afterTs, timeoutSec = 600, stableSec = 60, minQuietSec = 180}}`: eventos de la sesión y registros de los tres namespaces del actor, con clave `{memoryRecordId, createdAt, contentSha256}`; completitud por estrategia: `installerTips` con un registro nuevo o cambiado que coincide con el centinela; preferencias y resumen por registro nuevo o namespace quieto |
| `snapshot` | Orden, checklist, validaciones, pasos, casos con escalera, temporizadores pendientes, conversación, acta y entregas, bitácora, uso de turnos, `processError`, `TurnNote.stopReason` |
| `policyAudit.run`, `metrics.get` | Auditoría del mundo y KPIs |
| `probe.mocks` | `GET /v1/health` de los dos mocks con el rol del `QaDriver` y un `HEALTH_PROBE` por la cola (rol del worker) |
| `kb.probe` | `Retrieve` de una consulta fija con resultado esperado (`§SEG-01`) |
| `auth.probe` | Lee por IAM la configuración del cliente del user pool (solo SRP, tokens de 15 min, sin hosted UI, `writeAttributes = [name]`) y descarga el JWKS público (`SMK/2`) |
