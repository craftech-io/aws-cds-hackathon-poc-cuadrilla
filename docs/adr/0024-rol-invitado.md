---
status: accepted
---

# El rol de quien prueba la demo es `GUEST` (invitado), en el código, la infra, el seed, los tests y los docs

El diseño original tenía un rol `JUDGE` ("jurado") para los evaluadores del concurso: cuentas `judge-NN`, operadoras `isp-judge-<nn>`, relojes `JUDGE#…`, el claim `isJudge`, la plantilla de mundo `judge` y los escenarios del "recorrido del jurado". El nombre filtraba el contexto del concurso a superficies visibles (el rol en la consola, los legales, la landing) y no sirve para el producto: el mismo rol lo usa cualquier prospecto que se registra solo (ADR-0025). Decidimos:

- **Un solo rol para quien prueba la demo: `GUEST`**, "Invitado" en español y "Guest" en inglés. Tiene exactamente los permisos que tenía `JUDGE`: los de `SUPERVISOR` dentro de su propio mundo y de ningún otro, sin TOTP ni cambio de contraseña para las cuentas invitadas por el operador, con "Saltar a escena", "Reiniciar demo" y el simulador con sus topes. El comportamiento no cambia.
- **Tres orígenes del mismo rol** (`GuestOrigin`), que solo cambian cómo nace la cuenta, el ciclo de vida del mundo y sus topes:

  | Origen | Cuenta | Operadora y reloj | Mundo |
  |---|---|---|---|
  | `INVITED` | `guest-01..NN`, creadas por el operador con `console:invite --guest <nn>`; credenciales solo en las instrucciones privadas de la submission (P-03) | `isp-guest-<nn>` · `GUEST#isp-guest-<nn>` | Plantilla `guest`, creado en el primer login; `WorldJanitor` lo reinicia de noche si estuvo 24 h sin actividad; sin TTL mientras dura la ventana de las cuentas; topes de `docs/seed-spec.md` §4 (los que tenía `JUDGE`) |
  | `TEST` | `guest-test` (ensayo del operador) y el principal `usr-qa-guest` del `QaDriver` | `isp-guest-test` · `GUEST#isp-guest-test` | Igual que `INVITED`, con los topes de ensayo de `docs/seed-spec.md` §4 |
  | `SIGNUP` | Alta propia con email verificado (ADR-0025) | `isp-guest-s<yymmdd><5 base32>` · `GUEST#isp-guest-s<…>` (una operadora por generación de mundo, creada en forma condicional y con otro sufijo si choca, ADR-0025 §2) | Plantilla `guest`, creado al confirmar el email; TTL de 7 días reales; recreado en el login siguiente; topes de invitado por alta (ADR-0025) |

- **Renombre mecánico y completo**, derivado del código de las olas 0-1 y del trabajo en curso de la ola 2: `docs/guest-rename-map.md` tiene el mapa exacto (identificador viejo → nuevo, con el tipo y los archivos donde aparece). Cubre el grupo de Cognito (`JUDGE` → `GUEST`; el recurso `UserPoolGroupJudge` se reemplaza por `UserPoolGroupGuest`), el claim `isJudge` → `isGuest`, `Isp.kind` y `ConsoleRole`, los ids (`isp-judge-*` → `isp-guest-*`, `usr-judge-*` → `usr-guest-*`, `usr-qa-judge` → `usr-qa-guest`), los relojes (`JUDGE#` → `GUEST#`), la etiqueta de mundo (`judge` → `guest`), la etiqueta de reloj de los ids clonados (`wo-24817-j03` → `wo-24817-g03`), el prefijo de los códigos de alta (`J07`/`JTST` → `G07`/`GTST`), la letra del mundo en los schedules (`tm-j-…` → `tm-g-…`), la plantilla `Seed/worlds/judge.json` → `guest.json`, los escenarios (`sc-19-judge-world.ts` → `sc-19-guest-world.ts`), el ensayo (`scripts/judge/rehearsal.ts` → `scripts/guest/rehearsal.ts`), las constantes (`JUDGE_TEST_CLOCK_ID` → `GUEST_TEST_CLOCK_ID`, …), los fixtures y los nombres de los tests.
- Después del renombre, `grep -rIiE "judg|jurad"` sobre `infra/`, `packages/`, `scripts/`, `tests/` (incluido `tests/cases/`), `.github/`, `package.json` y `sst.config.ts` devuelve **cero** líneas: también se reescriben los verbos en comentarios ("how it is judged" → "how it is checked"), así la prueba del renombre es un grep sin excepciones.

## Considered options

- **Dejar `JUDGE` en el código y cambiar solo los textos**: el rol aparece en claims, grupos de Cognito, ids de mundo y logs que se ven en la consola de AWS y en capturas; dos nombres para una cosa es deuda de lenguaje (`CONTEXT.md`).
- **Un rol nuevo `GUEST` además de `JUDGE`**: duplica middlewares, pruebas y escenarios para un comportamiento idéntico.
- **Un solo rol con orígenes** (elegida).

## Consequences

- El renombre es el primer paso de la ola 2b (`docs/build-plan.md`, WP-51 a WP-54), solo, entre la ola 2 integrada y todo lo nuevo, para que ningún `git add -A` mezcle trabajo ajeno.
- Cognito: el grupo `JUDGE` desaparece y se crea `GUEST`; las cuentas `judge-*` no existen todavía (las crea `console:invite` de WP-39, ola 4), así que no hay usuarios que migrar. El pre-token estampa `role GUEST` e `isGuest`; el BFF y la web leen `isGuest`.
- Un item existente con `JUDGE#…` o `isp-judge-*` en `poc` (solo los que haya escrito un smoke de las olas 0-2) queda huérfano: después del primer deploy de la ola 2b, `devops` los lista con lecturas (`scan` con filtro por prefijo, profile del operador) y el operador los borra con confirmación explícita; nunca un script de CI.
- `docs/`, `CONTEXT.md`, `CLAUDE.md`, los agentes y `tests/cases/` usan "invitado"/`GUEST`; el concurso y sus evaluadores se nombran solo como contexto interno (ADR-0023).
