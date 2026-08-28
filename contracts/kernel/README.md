# `contracts/kernel/` — la superficie CONGELADA del hub

Estos ficheros **son el contrato del kernel**: lo que el hub le promete a los módulos publicados.
No se escriben a mano — cada uno lo **genera un test desde el código** y lo compara con la copia
commiteada. Si el código se desvía, el build rompe **nombrando** lo que sobra y lo que falta.

Decisión: ADR **«El Hub se CIERRA como KERNEL»** (2026-08-27) · contrato y mecanismo en
`architecture/hub/kernel-contract.md` §2 · issue [hub#1235].

No es un invento nuestro: es lo que hacen Kotlin (`apiCheck` / binary-compatibility-validator),
.NET (`PublicApiAnalyzers`) y `cargo-semver-checks` — la API pública vive en un fichero y el
`diff` de ese fichero es lo que revisa una persona.

## Qué es cada fichero

| Fichero | Qué congela | Lo genera |
|---|---|---|
| `routes.snapshot` | Cada ruta HTTP/WS de `app()`: método · ruta · clase de auth | `cargo test -p erplora-server --test kernel_contract_routes` |
| `engine.snapshot` | Motor declarativo: params inyectados, `hub.*`, capabilities, orígenes del dispatcher, `kind`s de migración, guardas de fila | `cargo test -p erplora-runtime --test kernel_contract_engine` |
| `guest.snapshot` | Contrato del guest WASM: campos de `Input`/`Output` y topes de `WasmLimits` | `cargo test -p erplora-runtime --test kernel_contract_guest` |
| `tables.snapshot` | Tablas de sistema (`hub_*`, `_*`) con sus columnas, **reflejadas** de un hub recién arrancado | `cargo test -p erplora-runtime --test kernel_contract_tables` (necesita Postgres, `DATABASE_URL`) |
| `sdk.d.ts` | API pública de `@erplora/module-sdk`, tal cual la emite `tsc` | `pnpm -F @erplora/module-sdk contract:check` (va en `pnpm verify`) |

La sexta superficie —el manifest `module.json`— **ya tenía su snapshot** desde ADR-0286: el propio
`schemas/module.schema.json`, vigilado por `crates/runtime/tests/manifest_fields_match_the_schema.rs`.
Por eso no está aquí.

## Cómo se actualiza

Regenerar es **explícito**, nunca automático: se pone `UPDATE_KERNEL_CONTRACT=1` delante del
comando de la tabla y el fichero se reescribe.

```sh
UPDATE_KERNEL_CONTRACT=1 cargo test -p erplora-server  --test kernel_contract_routes
UPDATE_KERNEL_CONTRACT=1 cargo test -p erplora-runtime --test kernel_contract_engine
UPDATE_KERNEL_CONTRACT=1 cargo test -p erplora-runtime --test kernel_contract_guest
UPDATE_KERNEL_CONTRACT=1 cargo test -p erplora-runtime --test kernel_contract_tables
UPDATE_KERNEL_CONTRACT=1 pnpm -F @erplora/module-sdk contract:check
```

**El diff resultante ES la revisión.** Un cambio en cualquiera de estos ficheros:

1. va en una PR con etiqueta **`kind:contract`** — sin ella la PR no mergea;
2. lleva **entrada en el decision-log** de `architecture/` en la misma tanda;
3. necesita **`test-hub-modules.yml` en verde** contra los módulos publicados: el kernel no rompe
   a un módulo instalado, nunca (regla de Linus; si rompe, se revierte el hub y el módulo se
   adapta **después**).

## Cómo se leen

- **`routes.snapshot`** — `MÉTODO RUTA auth:<clase>`. La clase se **deriva**, no se declara: es la
  primitiva de `crate::auth` a la que llega el handler a través de sus propios helpers y macros
  (`admin`, `session`, `api-key`, `any-credential`, `capability`). Varias clases se unen con `+`
  cuando el handler pasa por más de una puerta (`admin+capability`). Una sesión resuelta **a mano**
  (`auth::session_token` + `resolve_session`, como `/api/auth/set-pin`) cuenta como `session`.
  El token de máquina del hub (`hub_scoped_auth`/`machine_auth`) **no es una clase**: autentica al
  hub ante el Cloud, no al que llama al hub — listarlo pintaba de «puerta» rutas abiertas.
  `auth:none` significa literalmente **ninguna primitiva en ese camino**. Hoy son 17: el login
  (`/api/auth/*` salvo `set-pin`), las sondas (`/healthz`, `/readyz`, `/robots.txt`), los assets de
  módulo (`/modules/**`), el modo del dispositivo que lee la pantalla de login, `/api/hub/context`,
  `/api/error-report`, `/p/:locator` —cuya autorización **es el localizador** (hub#963)— y dos que
  el fichero deja a la vista a propósito: `GET /api/assistant/config` y `POST /api/assistant/checkout`
  (hub#1254). Que una ruta abierta salga como `none` es la función del fichero, no un defecto suyo.
  Si aparece una forma nueva de gatear una ruta hay que añadirla a la tabla `PRIMITIVES` del test,
  o todas las rutas que gatee saldrán como `none`.
- **`engine.snapshot`** — por secciones. `[system_params]` sale de una llamada REAL a
  `system_params`, no de una copia de sus claves. `[capabilities]` se cruza con el bloque
  `capabilities` de `schemas/module.schema.json`: lo que el host gatea y lo que el schema deja
  declarar no pueden divergir.
- **`tables.snapshot`** — reflejado de `information_schema` tras `Runtime::ensure_system_tables`,
  no parseado del SQL: un `CREATE TABLE` que Postgres rechazaría no puede colarse aquí.
- **`guest.snapshot`** — obtenido SERIALIZANDO valores reales, así que respeta
  `#[serde(transparent)]` y `skip_serializing_if`. Un `.wasm` publicado no se recompila: renombrar
  un campo de aquí rompe a la vez a todos los handlers Tier 2 instalados.

## Lo que NO va aquí

Superficie declarada que **no existe** se retira, no se congela (`navigation[].actions`,
`render.pdf`/`render.xlsx` — hub#1237). Y una superficie nueva entra marcada `experimental`, fuera
del schema que valida `erplora validate`, hasta que una ADR la fija como `stable`.
