# @erplora/module-toolkit

Toolkit de módulos de ERPlora, **estilo Ionic CLI**: scaffolding + dev preview + build, en un
solo "envoltorio". El repo de cada módulo queda **limpio** (solo source + manifest); el toolkit
aporta las dependencias y la configuración de build.

> Repo propio, fuera del pnpm workspace de `hub/`. Naming/estructura decididos por el humano
> (2026-06-07): paquete `@erplora/module-toolkit`, comandos `startproject` + `g module`,
> resolución de deps por inyección del CLI (no por registry), IntelliSense vía `tsconfig` paths.

## Modelo (decidido)

- **Proyecto contenedor + `g module`** (opción 2). `erplora startproject <n>` crea un
  **workspace de desarrollo** que puede contener varios módulos; `erplora g module <id>` añade
  cada módulo. El contenedor es **solo para dev** (aporta `tsconfig`/paths compartido y deja a
  `dev`/`build` apuntar a cualquier módulo): **cada módulo sigue siendo su propio repo git y se
  publica al marketplace de forma independiente** — el contenedor no es la unidad publicable.

## Comandos

| Comando | Estado | Qué hace |
|---|---|---|
| `erplora startproject <n>` | ✅ | Crea el workspace contenedor de dev (Ionic + OutfitKit instalados por defecto). |
| `erplora g module <id>` | ✅ | Genera un módulo (repo propio): manifest + WC Lit (`ok-data-table`) + SQL + fixtures. |
| `erplora g view\|command\|query <id> <n>` | ✅ | Añade piezas dentro de un módulo existente. |
| `erplora dev <id\|dir> [puerto]` | ✅ | Preview del WC con Ionic + transport mock (fixtures/sintético), CSP estricta, watch. |
| `erplora build <id\|dir>` | ✅ | Compila el WC (Lit) a `dist/<id>.esm.js` (auto-contenido, CSP-safe) **y recompila el handler WASM** a `dist/handler.wasm` si hace falta (module-toolkit#26). |
| `erplora validate <id\|dir> [--pg]` | ✅ | Valida el manifest (contrato `architecture/hub/module-system.md`) + CSP del bundle + handlers WASM (si `handler.type === "wasm"`, rechaza un `dist/handler.wasm` desincronizado del fuente — guardarraíles module-toolkit#135 y #26). Con `--pg`, además **PREPARA** cada SQL declarado contra un Postgres efímero (§ *Que el SQL prepare de verdad*). |
| `erplora pack <id\|dir>` | ✅ | `module.zip` + `manifest.lock.json` + SHA256 (en `<módulo>/build/`). |
| `erplora sign <id\|dir>` | ✅ | (re)calcula el SHA256 del zip (firma con clave: pendiente, §7.4). |
| `erplora publish <id\|dir>` | 📋 guía | Imprime el flujo de publicación al marketplace (no automatizado: auth + confirmación). |

> `build`/`dev`/`pack`/`validate` aceptan una **ruta** o un **id suelto** (resuelve a `modules/<id>`
> dentro de un workspace).

## Cómo resuelve las deps un módulo standalone (el nudo técnico)

Un repo de módulo vive **fuera de cualquier workspace** y **no declara** `lit` ni `@erplora/*`.
Al compilar, [`src/resolve-plugin.mjs`](src/resolve-plugin.mjs) intercepta todos los specifiers
`lit*` y `@erplora/{outfitkit,module-sdk,module-types}*` y los resuelve **siempre desde el
`node_modules` del toolkit** (vía `import.meta.resolve`, honrando los `exports` maps).

Esto además **deduplica `lit`**: tanto el WC del módulo como el `dist` de `@erplora/outfitkit`
importan `lit`/`lit/decorators.js`/`lit/directives/*`; sin el plugin esbuild metería **dos copias**
de Lit en el bundle (decoradores y reactive-controllers rotos). Verificado: el bundle final
contiene **una sola** `ReactiveElement`.

Bundle **auto-contenido** (lit + outfitkit dentro), **sin import-map, sin externals** — decisión
2026-06-07: bajo `script-src 'self'` un import-map inline viola la CSP. Mismo contrato de salida
(`dist/<id>.esm.js`) que el antiguo `@erplora/module-cli`, para no tocar `module-loader`/`sync-modules`.

## El handler Tier 2 (`handler/` → `dist/handler.wasm`)

Un módulo con lógica Tier 2 lleva un crate Rust en `handler/`; el binario que viaja en el
`module.zip` es `dist/handler.wasm`. Hasta el 2026-08-07 `erplora build` **no lo tocaba**: si
editabas `handler/src/lib.rs` y no te acordabas de compilarlo a mano, el módulo se publicaba con la
lógica vieja y el manifest nuevo — y **no fallaba nada** hasta llegar a un hub real (los tests del
handler corren sobre el Rust, no sobre el binario). Pasó en `tables` y en `pricing` el mismo día
(module-toolkit#26).

- **`erplora build`** compila el handler (`cargo build --release --target wasm32-unknown-unknown
  --features guest`) cuando el binario no está al día, lo copia a `dist/handler.wasm` y deja al lado
  un **sello** `dist/handler.build.json` (sha256 de `handler/` + sha256 del binario). Si ya está al
  día no recompila; si **no puede** recompilar (sin `cargo` o sin el target wasm32) **falla en voz
  alta** en vez de empaquetar lógica vieja.
- **`erplora validate`** (y por tanto `pack`) **rechaza** un binario desincronizado: que exporte
  todas las funciones que el manifest enruta (`commands[].handler.function`) y que corresponda al
  source. Para lo segundo se usa la mejor evidencia disponible — el sello, si no el historial de
  git (fuentes tocadas sin recompilar, o `handler/` commiteado después del binario) y, en último
  término, las fechas de fichero.

## Que el SQL prepare de verdad (`--pg`) — module-toolkit#32

El barrido de los 24 módulos publicados (ERPlora/pm#107, 2026-08-09) encontró **4 con SQL que
Postgres no puede ni PREPARAR**, y `erplora validate` solo señalaba **1**. Como desde ADR-0154 los
módulos publican únicamente dialecto `postgres`, «no prepara» significa que ese command/query **no
existe en ningún hub**: no hay motor de repuesto. Hay dos puertas, y las dos hacen falta.

**Puerta 1 — reglas léxicas** (`src/validate-pg.mjs`, siempre, sin dependencias):

- `onconflict-unqualified` (ERROR) — dentro de `ON CONFLICT … DO UPDATE SET`, **cualquier**
  columna de la tabla destino sin cualificar, en la forma que sea. Antes solo veía
  `col = col + 1`; `reservations` publicó **13** columnas en la forma envuelta
  (`col = COALESCE(:p, col)`) con `validate` en verde.
- `null-untyped` (ERROR desde #32, antes warning) — `:param IS [NOT] NULL`. Postgres fija el tipo
  de un bind en su **primera** aparición e `IS NULL` no aporta ninguno, así que en cuanto el bind
  llega NULL el PREPARE muere con 42P08. Compararlo con una columna más abajo **no** lo salva. El
  arreglo portable es `CAST(:param AS TEXT)` (no `::text`, que SQLite no entiende). Así estaban
  rotos `appointments` (agenda global) y `tasks` (crear tarea sin proyecto).

**Puerta 2 — preguntarle a Postgres** (`erplora validate <dir> --pg`): levanta una BD de scratch con
las `migrations/postgres` **del propio módulo**, baja el SQL igual que el runtime (funciones-puente
`erp_*` → expresión nativa, `:name` → `$n`) y hace `PREPARE` de cada sentencia declarada. Es lo que
caza `whatsapp_inbox` (`m.created_at >= erp_month_start(:now)` = `TEXT >= timestamptz`), que ninguna
regla léxica plausible puede ver.

- Necesita Docker y un contenedor Postgres (`erplora-test-pg-5433` por defecto; se cambia con
  `ERPLORA_TEST_PG_CONTAINER`). Sin él, `validate --pg` **falla diciendo que no pudo comprobar
  nada**: la bandera es opt-in, y quien la escribe en un job de CI pidió esta puerta — avisar y
  salir con 0 convertiría «nadie lo miró» en verde.
- Dos clases se reportan como **warning**, no como fallo, porque son límites del check y no del
  módulo: usar una tabla de **otro módulo o del core** (`inventory` → `sales_sale_item`), y un
  fallo que depende del **tipo de un bind que nadie declara** (sin `schema`, el runtime manda el
  tipo JSON del caller). Medido sobre los 24 módulos: **0 errores, 6 warnings**.
- Un fallo **estructural** (columna ambigua, tabla propia inexistente, sintaxis) es error aunque
  haya binds sin declarar: ningún caller puede arreglarlo.

## El gate de CI de los repos de módulo (ERPlora/pm#107)

El validador **es** el gate: los 24 repos de módulo lo llaman desde aquí. Dos piezas, las dos en
este repo, para que arreglar un agujero no sean 24 PRs:

| Pieza | Qué es |
|---|---|
| `.github/actions/validate-module/action.yml` | composite action: instala `typescript`, levanta el Postgres de scratch y corre `erplora validate <dir> --pg` |
| `.github/workflows/module-gate.yml` | workflow **reutilizable** (`workflow_call`) que hace el checkout del repo llamante y ejecuta la action |

El stub que va en cada repo de módulo (`.github/workflows/module-gate.yml`) son ~10 líneas:
`on: pull_request` + `uses: ERPlora/module-toolkit/.github/workflows/module-gate.yml@main`. Además
el `release.yml` de cada módulo pasa a llevar `needs: gate`, así que el bump de versión —que es lo
que hace que el SaaS republique— **no ocurre si el gate está rojo**.

**Por qué aquí y no en cada repo.** El validador es privado y el `GITHUB_TOKEN` de un repo de
módulo no puede hacer checkout de otro repo privado. Una composite action es la única forma que
GitHub resuelve **sin credencial**, con el ajuste *Settings → Actions → Access → accessible from
repositories in the organization* puesto en este repo. Así no hay un PAT del hub/toolkit repartido
por 24 repos, y el gate corre siempre el validador de `main`, no el del día que se escribió el stub.

**Qué NO cubre el gate: compilar el handler a wasm32.** Los 21 módulos con `handler/` dependen del
`guest-sdk` del hub **por ruta relativa** (`../../../../hub/crates/guest-sdk`) y en un runner no hay
checkout de `ERPlora/hub`. Se decidió dejarlo fuera, no clonar el hub:

- clonarlo exige un **PAT con lectura de `ERPlora/hub` en los 24 repos** — 24 copias de una
  credencial que abre el core entero, por una comprobación;
- ata cada PR de módulo al `main` del hub: un cambio en el `guest-sdk` pone en rojo 21 repos que no
  han tocado nada (el falso positivo `no 'tax' in the root` del barrido, otra vez pero al revés);
- el coste en minutos es lo de menos y aun así se midió: `rustup target add wasm32` + `cargo build`
  en frío ≈ **+2 min por run** sobre los ~2 min del gate.

Lo que sí queda cubierto sin `cargo`: que `dist/handler.wasm` **no esté desfasado** respecto al
source Rust del commit (hash de `handler/src` + `Cargo.lock`) y que exporte las funciones que el
manifest enruta. Que el Rust compile se ve en local en cuanto se toca (`erplora build` lo recompila
y se niega a publicar un binario viejo). El validador nunca miente sobre esto: la línea de resumen
dice **`handler WASM SIN VERIFICAR`**.

La salida sería consumir el `guest-sdk` **versionado** en vez de por ruta; mientras siga siendo una
ruta relativa, esta puerta no puede cerrarse en CI sin pagar las otras dos facturas.

## Workspace local (lo que existe hoy)

Los **24** módulos viven en **`ERPlora/modules-workspace/`** (creado con `startproject`, cada
módulo su propio repo git en `modules/<id>/`; recuento vivo: `ls modules-workspace/modules/` —
los retirados están en `_retirados/`). Para trabajar:

```sh
cd modules-workspace
npm install                 # toolkit + Ionic + OutfitKit + SDK + lit (registry público vía .npmrc)
npx erplora dev inventory   # preview en http://localhost:4321 (CSP-safe, watch)
npx erplora build inventory # → modules/inventory/dist/inventory.esm.js
npx erplora pack inventory  # module.zip + sha256 en modules/inventory/build/
```

El Hub consume los `dist/` de aquí: `hub/apps/web/sync-modules.mjs` apunta a
`../../../modules-workspace/modules` y `pnpm -F @erplora/web verify` queda VERDE.

## Pendiente / deuda conocida

- **Firma criptográfica** (`sign`): hoy solo SHA256; la firma con clave del marketplace está
  pendiente (decisión humano, §7.4). El Hub re-verifica SHA256 al instalar (`architecture/hub/module-system.md` §5).
- **`publish`**: deliberadamente NO automatizado (acción autenticada contra Cloud + S3 inmutable).
  Imprime el flujo; subir+registrar requiere confirmación y credenciales.
- **`hub/packages/module-cli`** queda **deprecado** (ver su `DEPRECATED.md`). Borrarlo (y limpiar
  los scripts `build:*` del `package.json` raíz de `hub/`) es **decisión del humano**.
- **Distribución a devs externos**: `@erplora/outfitkit` **ya está publicado en npm** (v0.1.31,
  MIT); en el workspace local se enlaza por `file:../outfitkit`. `@erplora/module-sdk` +
  `@erplora/module-types` siguen enlazados por `file:../hub/packages/*` (uso interno): para
  terceros del marketplace queda **publicar/vendorizar** solo esos dos. Fase aparte.
