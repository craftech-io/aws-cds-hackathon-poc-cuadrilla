---
status: accepted
---

# Un paso que mezcla tipos se divide en partes, y las claves de la tabla de oráculos tienen una gramática cerrada

La compuerta "100 % probada" (`docs/test-plan.md` §1) exige que cada paso `det` pase 3 de 3 y cada paso `agent` pase su oráculo en ≥ 2 de 3. `flows:check --strict` la hace verificable: cada paso declara un solo `kind`, un solo `after` y, si hace falta, un solo `oracleFlow`. Varios pasos de §4.5 mezclaban segmentos `[det]` y `[agent]` bajo un mismo número (`SC-18/4` tenía el indicador de mundo ocupado, la transcripción en el mundo `GUEST#isp-guest-test` y la respuesta con cita), y la matriz los citaba por el número pelado. Cualquier forma de codificarlos rompía algo: como `agent`, los asserts deterministas de FL-017 y FL-085 dejaban de exigirse 3 de 3; como `det`, la cita del modelo se exigía 3 de 3 y fallaba de a ratos; con sub-pasos inventados, las citas de la matriz dejaban de resolver. Además, la tabla de oráculos usaba calificadores libres ("paso con turno real", "(a)") y la fila de las fotos exigía una reacción y un ítem `PASSED` que los pasos por `tool.invoke` nunca pueden producir.

Decidimos:

- **Partes.** Un paso de §4.5 con más de un segmento de tipo se escribe en partes `n.a`, `n.b`, … en orden, y cada parte declara sus propios `kind`, `flows`, `after`, `oracleFlow` y `expect`; se evalúan por separado. `flows:check` compara las partes del código con las de §4.5.
- **Citas.** `SC-nn/m.p` cita una parte; una cita a un paso entero, o a un rango, exige que **todas** sus partes declaren el flujo; si solo algunas lo declaran, la cita nombra las partes. Las revisiones propusieron dos alternativas: expandir la cita pelada a las partes y aceptar que una sola declare el flujo, o reescribir las citas con partes. Elegimos la más segura, que combina las dos: la cita pelada solo vale si todas las partes declaran el flujo, y las citas de la matriz nombran la parte cuando no es así (FL-017 → `SC-18/4.b`, FL-085 → `SC-18/4.a`, FL-050, FL-040, FL-046, FL-072, FL-101, FL-016). Así una cita nunca queda satisfecha por una parte de otro tipo.
- **`after` por id.** `after` vale `preset`, `scene` o el id de un paso o parte anterior; `steps.test.ts` rechaza un `det` que depende de un `agent`, incluso de una parte del mismo paso.
- **`oracleFlow` solo en `agent`.** Una parte `det` con `oracleFlow` falla.
- **Claves de oráculo.** Gramática cerrada: flujo, rango o lista; `(variante x)` solo con un alcance de pasos; alcance propio, o "y demás pasos" para las filas generales. La precedencia por par es: primero la fila con alcance propio, después la general de ese solo flujo y por último la general de rango o de lista. Un empate falla.
- **Fotos por `tool.invoke`.** Una fila propia para `SC-04/3..8`, `SC-04/9.a`, `SC-04/10..11` y `SC-04/14` exige la validación de la clase esperada, el `reasonText` de `copy/` y el `CHECK#` coherente (`REJECTED`, `IN_REVIEW` o **no** `PASSED`), y ninguna reacción. La fila general queda para los pasos con turno real. `SC-04/8` ya no espera la oferta de usar la foto para la roseta, que exige un turno.

## Considered options

- **Un `kind` por paso y citas peladas que se expanden con una sola parte que declare el flujo**: es más simple, pero una cita puede quedar satisfecha por una parte de otro tipo sin que nadie lo note.
- **Reescribir solo las citas, sin gramática de partes**: el ejecutor y `flows:check` tendrían que adivinar cómo se llama cada sub-paso.
- **Partes con citas estrictas y gramática cerrada de claves** (elegida).

## Consequences

- `scripts/flows/check.test.ts` y `scripts/scenarios/lib/steps.test.ts` suman los casos de partes, citas, claves, variantes y precedencia (`docs/test-plan.md` §3). Los reciben WP-03 y WP-45.
- Toda parte de `SC-18/4` y de `SC-18/11` declara `FL-082`, así `SC-18/3..12` sigue siendo una cita válida.
- Un paso nuevo que mezcle tipos se escribe con partes desde el principio. Una fila de oráculo nueva usa la gramática, o `flows:check --strict` la rechaza.
