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
| `erplora validate <id\|dir> [--pg]` | ✅ | Valida el manifest (contrato `architecture/hub/module-system.md`) + CSP del bundle + handlers WASM (si `handler.type === "wasm"`, rechaza un `dist/handler.wasm` desincronizado del fuente — guardarraíles module-toolkit#135 y #26). Con `--pg`, además **PREPARA** cada SQL declarado contra un Postgres efímero (§ *Que el SQL prepare de verdad*). Rechaza también un canal de `host.notify` sin transporte y avisa del techo de permisos de los handlers (§ *Dos guardas del contrato del runtime*), y un `fill` de Ionic que el hub no va a pintar (§ *El `fill` que el hub NUNCA pinta*). |
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

## Dos guardas del contrato del runtime (hub#689 y hub#459)

Las dos comparten la misma forma: el runtime **ya** se niega en su sitio, pero se niega delante de
un cliente. `validate` (y por tanto `pack`/`publish`) mueve el descubrimiento al único momento en
que aún es barato.

**Canales de `host.notify` sin transporte — ERROR** (`src/validate-notify-channels.mjs`, hub#689).
ADR-0012 anuncia `email`/`sms`/`whatsapp` y el schema los admite, pero el SaaS solo hace de proxy de
email y whatsapp (ADR-0283 §5) y el hub no guarda credencial de SMS propia: `Channel::Sms` devuelve
error en el envío. Un manifest que declare `sms` —en `capabilities.notify.channels` o en el bloque
`notify` legacy— se rechaza. La lista es **positiva** (`SUPPORTED_NOTIFY_CHANNELS`): el día que haya
transporte de SMS se mueve una entrada, y un canal inventado (`telegram`) cae por el mismo camino.
Es error y no aviso porque hoy no lo declara ningún módulo publicado: no rompe a nadie.

**El techo de permisos de un handler — WARNING** (`src/validate-handler-permissions.mjs`, hub#459
paso 3). `commands::validate_operation` resuelve una op de handler a SQL sin mirar el permiso del
command destino, así que un command de cajero puede alcanzar por handler el SQL de uno de encargado
sin que nadie pida el PIN. El gate de verdad va en el runtime y es una migración de catálogo; aquí
solo se **avisa**, para que el autor realinee su módulo antes de que el gate exista. Se parte de la
función que el manifest enruta, se recorre el grafo de llamadas local del `handler/` y se comparan
los permisos de los commands que ese camino nombra literalmente, rol a rol (`role_permissions`).

> Medido sobre los 25 módulos del workspace: **3 cruces reales** (los tres en `appointments`, hacia
> `_insert_history`). El barrido a mano de hub#459 contaba 84 porque comparaba el fuente ENTERO del
> handler contra cada command con handler; repetido así aquí da 80 — los otros 77 son caminos que
> ese command no recorre. La reachability por función es lo que separa una cosa de la otra.

## El `fill` que el hub NUNCA pinta (hub#760)

`src/validate-ionic-fill.mjs`. Ionic lo decide en una línea
(`@ionic/core/…/input/input.js`):

```js
const hasOutlineFill = mode === 'md' && this.fill === 'outline';
```

y `input.ios.css` no trae **ninguna** regla `input-fill-*`. El shell del hub fija `mode: 'ios'`
(ADR-0143, `hub/apps/web/src/main.ts`), así que un `fill` en un `ion-input`/`ion-select`/
`ion-textarea` es un **no-op silencioso**: el campo sale sin caja, sin borde y sin fondo, y el
usuario no ve dónde escribir. No lanza nada y no avisa de nada — por eso hace falta algo que lo
mire por ti. En `ion-button`/`ion-chip` el `fill` **sí** es real en `ios`: ahí no se toca.

La defensa ya existía **por duplicado y en los dos sitios equivocados**: el hub se protege en su
código (`apps/web/src/theme/ionic-fill-needs-md.test.ts`) y el Cloud también
(`saas/tests/unit/test_ionic_fill_needs_md.py`, saas#1080), pero ninguna de las dos puertas mira los
**módulos**, que es donde vive la mayor parte de los formularios que rellena el comerciante. Medido
sobre `origin/main` de los 25 repos: **275 de 298 controles** declaran `fill` y **ninguno** declara
`mode="md"`.

**No es una copia del escáner del hub.** El hub lee `.vue`, donde una etiqueta acaba en el primer
`>`. Una plantilla Lit no: `@ionChange=${(e: any) => this.patch({ id: e.target.value })}` mete `>` y
`{}` **dentro** de la etiqueta. Cortar en el primer `>` leería como ausente todo atributo posterior
a una arrow function —`mode="md"` incluido— y delataría un control que está bien. Un falso positivo
aquí pone en rojo el gate de un módulo correcto, que es peor que el bug que se persigue.

**Trinquete, no big-bang.** Poner esto en error de golpe deja los 25 repos en rojo el mismo día por
algo que no tiene que ver con lo que cada uno estaba publicando — y un gate que bloquea todo se
apaga, no se obedece. Así que el pase es **por fichero Y por número** (`FILL_GRANDFATHERED`): los
controles que un fichero tiene hoy se toleran, **uno más no**, y un componente nuevo no hereda nada.
La lista **solo puede encoger**; la vacía el barrido de ERPlora/pm, módulo a módulo.

**Con alarma sobre su propia premisa.** `test/validate-ionic-fill.test.mjs` lo comprueba contra la
dependencia (no contra una copia): el día que Ionic pinte `fill` en `ios`, falla y dice que la
comprobación **sobra**. `test/canonical-mirrors.test.mjs` hace lo propio con el pin `mode: 'ios'` del
shell, y además corre este escáner sobre las vistas `.vue` del hub —limpias por su propio guard— para
que las dos puertas no digan cosas distintas del mismo marcado. Un chequeo que sobrevive a su causa
es peor que no tenerlo: enseña que el gate pide cosas que dan igual.

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
