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
| `erplora build <id\|dir>` | ✅ | Compila el WC (Lit) a `dist/<id>.esm.js` (auto-contenido, CSP-safe, con las rutas normalizadas para que salga igual desde cualquier cwd — module-toolkit#93), deja el sello `dist/<id>.build.json` **y recompila el handler WASM** a `dist/handler.wasm` si hace falta (module-toolkit#26). |
| `erplora validate <id\|dir> [--pg]` | ✅ | Valida el manifest (contrato `architecture/hub/module-system.md`) + CSP del bundle + handlers WASM (si `handler.type === "wasm"`, rechaza un `dist/handler.wasm` desincronizado del fuente — guardarraíles module-toolkit#135 y #26). Con `--pg`, además **PREPARA** cada SQL declarado contra un Postgres efímero (§ *Que el SQL prepare de verdad*). Rechaza también un `dist/<id>.esm.js` con rutas de la máquina que lo compiló o desfasado respecto de `ui/` (§ *El bundle publicado*), un canal de `host.notify` sin transporte, una guarda de filas que no se puede armar (`min_affected_rows` sobre un lote, un ancla `expect_rows.statement` colgando — hub#1091) y avisa del techo de permisos de los handlers (§ *Dos guardas del contrato del runtime*), un `fill` de Ionic que el hub no va a pintar (§ *El `fill` que el hub NUNCA pinta*), un `color=` en un `ion-*` que sale invisible dentro del componente (§ *El `color=` que no cruza el shadow root*), la **tenancy** que el SQL del módulo tiene que escribir con binds `:hub_id` (ADR-0423, `validate-hub-scope.mjs`), el catálogo `errors` del manifest (ADR-0398) y los filtros de lista muertos o con la caja equivocada (ADR-0125). |
| `erplora test <id\|dir> [--list] [--against-hub [<imagen>]]` | ✅ | Corre **los tests que el módulo ya trae**: sus baterías `tests/**/*.test.py|.sh` (las que necesitan Postgres usan el contenedor de `ERPLORA_TEST_PG_CONTAINER`), **sus tests de TypeScript** `ui/**/*.test.ts` bajo vitest + happy-dom **y los tests Rust del handler** (`#[cfg(test)]` en `handler/**`, bajo `cargo test`; fuera del monorepo, con el checkout del hub de `ERPLORA_HUB_DIR`) (§ *Los tests que el módulo ya tenía*). Falla si queda un test que **nadie** va a ejecutar. `--list` los enumera sin correrlos — es lo que el gate lee para decidir qué instalar. Con `--against-hub` levanta el **kernel real** y corre contra él las baterías `*.hub.test.py|.sh` (§ *La batería contra el kernel REAL*). |
| `erplora contracts <id\|dir>` | ✅ | (Re)genera `.erplora/contracts.json`: la superficie de OTROS módulos que este consume, extraída por AST de las llamadas al SDK (ADR-0127). |
| `erplora pack <id\|dir>` | ✅ | `module.zip` + `manifest.lock.json` + SHA256 (en `<módulo>/build/`). |
| `erplora sign <id\|dir>` | ✅ | SHA256 del zip **y firma ed25519 al lado** (`<zip>.sig` con `key_id`, clave privada en `MODULE_SIGNING_KEY`; ADR-0193). Sin clave **falla**: decir «✓ sign» sin haber firmado nada era justo lo que hacía la versión anterior. El Hub la verifica contra su anillo (`HUB_MODULE_TRUSTED_KEYS`) antes de instalar. |
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

## El bundle publicado (`ui/` → `dist/<id>.esm.js`) — module-toolkit#93

El bundle **se publica tal cual**: el `module.zip` lleva `dist/` verbatim y nadie lo reconstruye
aguas abajo. Hasta el 2026-08-28 lo único que `erplora validate` leía de ese fichero era la CSP, así
que ni su **procedencia** ni su **frescura** estaban miradas — y las dos fallaron de verdad:

- `ERPlora/verifactu@63039d3^:dist/verifactu.esm.js` llevaba **8 comentarios de esbuild con una ruta
  a un scratchpad temporal de otro agente**. Alguien construyó desde un clone de usar y tirar y
  commiteó el resultado.
- Una PR que toca `ui/**` sin `erplora build` publica **la pantalla vieja** bajo el manifest nuevo.
  En el barrido del 2026-08-28 sobre los 27 módulos publicados, `flows` estaba así: la clave
  `ui.tplNeedsModules` que añadió flows#38 el 23/08 **no está** en su `dist`.

- Un merge que solo toca `locales/**` publica **las cadenas viejas**. Los 27 módulos escriben
  `import esLocale from '../../../locales/es.json'` en su componente, así que esbuild **inlinea** el
  catálogo en el bundle; y `locales/**` es ruta disparadora de `release.yml`, así que ese merge
  **sube versión y republica** con el catálogo anterior dentro. Medido sobre `origin/main` el
  2026-09-02: **65 commits en 60 días** tocaron `locales/` sin tocar `dist/`, y **4 de los 27
  módulos publicados** (`invoice`, `invoice_series`, `sales`, `staff`) estaban en ese estado —
  `sales` servía la pantalla de ajustes del TPV **sin ninguna de sus etiquetas en español**.

**`erplora build`** normaliza las anotaciones de ruta que esbuild deja antes de cada entrada (las
del módulo, relativas al módulo; las de una dependencia, por el `name` de su paquete), de modo que
**el bundle sale byte a byte igual desde cualquier directorio de trabajo**, y escribe un **sello**
`dist/<id>.build.json` (sha256 del árbol de `ui/` + sha256 de `locales/` + sha256 del bundle).

**`erplora validate`** (y por tanto `pack`) comprueba dos cosas sobre ese fichero:

- **Procedencia — ERROR siempre.** El bundle no puede llevar rutas absolutas (`/Users/`, `/home/`,
  `C:\`) ni rutas que entren en un directorio temporal o un scratchpad (`/tmp/`, `/private/tmp/`,
  `/var/folders/`, `…/scratchpad/…`), **estén escritas en absoluto o en relativo** — la de
  `verifactu` era relativa. Cero de los 27 bundles publicados lleva ninguna, así que aquí no hay
  nada heredado.
- **Frescura — con trinquete.** El bundle tiene que corresponder al `ui/` **y al `locales/`**
  actuales, con la misma
  jerarquía de evidencia que el handler WASM: **sello** → **git** (cambios sin commitear, o `ui/`
  commiteado después del bundle) → **fechas de fichero**. Los ficheros que nunca entran en el
  artefacto (`*.test.ts`, `*.spec.ts`, `*.d.ts` y los directorios de apoyo a tests `ui/test/`,
  `tests/`, `__tests__/`, `__mocks__/`) quedan fuera de las tres capas: un commit que solo toca un
  test no desfasa nada, y decir lo contrario es como un gate se gana que nadie lo lea.

  El trinquete: **con sello es ERROR, sin sello es AVISO**; poner 27 repos en rojo por un cambio
  nuestro es como se acaba desactivando un guardarraíl, así que en cuanto un módulo se construye una
  vez gana el sello y a partir de ahí falla. El mismo trinquete se aplica **campo a campo**: un
  sello escrito antes de module-toolkit#158 no lleva `locales_sha256`, así que no responde por el
  catálogo hasta que el módulo se vuelve a construir — y `sources_sha256` **sigue significando
  exactamente `ui/`**, porque mover su significado pondría en rojo a los que ya tienen sello.

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

**Guardas de filas que no se pueden armar — ERROR** (`src/validate-row-gates.mjs`, hub#1091). Un
command declara como mucho UNA guarda de filas afectadas: `min_affected_rows` (entero, error
genérico) o `expect_rows` (la traducible, con código de dominio). Las dos cuentan el **LOTE**, y ahí
estaba el agujero: una sentencia incondicional al lado de la vigilada —un UPSERT de contador, un
INSERT de auditoría— satisface el mínimo **por la que falló**, así que el command contesta `200 ok`,
no escribe nada y emite el evento igual. `expect_rows.statement` lo cierra anclando la guarda a UNA
sentencia; `min_affected_rows` **no puede** (es un entero: no tiene dónde nombrarla), y no se deja
combinar con `expect_rows`. Se rechazan los tres casos que el installer rechaza: `min_affected_rows`
sobre más de una `sql`, un ancla que no nombra ninguna de las `sql` del command, y las dos guardas
juntas.

> Por qué es una comprobación propia y no sale del schema: `module.schema.json` lo declara con un
> `if/then`, pero `checkManifestKeys` es un **walker** —claves desconocidas, patrones, vocabularios
> cerrados— y **no evalúa condicionales**. Sin este fichero la restricción sería cierta solo en el
> hub, y el autor se enteraría al INSTALAR, con el módulo publicado. Es error y no aviso porque no
> rompe a nadie: en los 27 repos de módulo `min_affected_rows` aparece **una** vez
> (`flows.drafts.resolve`) y es de una sola sentencia — hay un test que fija esa forma.

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

## La tabla guardia que no puede decir QUÉ falló (module-toolkit#92)

`src/validate-gate-constraints.mjs`. Ojo con el nombre: **no** es `validate-row-gates.mjs` (aquella
mira `min_affected_rows`/`expect_rows`, las guardas sobre cuántas FILAS tocó el `sql`). Esta mira la
**tabla guardia** `<módulo>__gate`, que es como un command declarativo se niega en SQL: un assert
inserta `(gate, ok)` con `ok = 1` solo si el invariante se cumple, y un `ok = 0` viola un CHECK que
revierte la transacción entera del command.

El patrón se copió con el CHECK **anónimo**, `CHECK (ok = 1)`. Postgres lo auto-nombra
`<tabla>_ok_check`, así que **todos** los gates del módulo fallan con el mismo mensaje primario y el
nombre del que saltó viaja en un campo aparte:

```
ERROR:   new row for relation "verifactu__gate" violates check constraint "verifactu__gate_ok_check"
DETAIL:  Failing row contains (config_save_requires_issuer, 0).
```

**DETAIL no llega al llamante**: el rechazo sale como `sqlx::Error::Database` sobre
`PgDatabaseError`, cuyo `Display` escribe solo el mensaje primario y cuyo `message()` lo descarta.
El código que intente decir POR QUÉ se rechazó no puede casar nunca — en `verifactu` eso le contaba
a un hub sin obligado tributario el problema del OTRO gate (verifactu#40).

El arreglo canónico es el de `verifactu/migrations/postgres/012_named_gate_constraints.sql`: la
identidad del gate se mueve de la FILA al NOMBRE de la constraint, que sí forma parte del mensaje
primario. Una por gate, acotada a su propio valor —así solo UNA puede violarse por fila, y deja de
hacer falta un orden de evaluación que Postgres no promete— más la lista blanca:

```sql
ALTER TABLE m__gate DROP CONSTRAINT IF EXISTS m__gate_ok_check;
ALTER TABLE m__gate ADD CONSTRAINT stock_is_available
    CHECK (gate <> 'stock_is_available' OR ok = 1);
ALTER TABLE m__gate ADD CONSTRAINT m__gate_is_declared
    CHECK (gate IN ('stock_is_available'));
```

Qué se comprueba, sobre el estado FINAL de la cadena de migraciones:

- **ERROR** — queda viva una CHECK sobre `ok` que no discrimina por `gate` (anónima o nombrada: un
  solo nombre para todos los gates es el mismo defecto con mejor letra).
- **ERROR** — la tabla tuvo una CHECK sobre `ok` y se quedó **sin ninguna**. Es el riesgo que crea
  esta misma puerta al pedir un `DROP`: media instrucción deja la tabla aceptando `ok = 0`, el
  command responde OK y el invariante desaparece sin que falle nada.
- **AVISO** — hay constraints por gate pero ninguna lista blanca sobre `gate`. Una fila cuyo `gate`
  no case con ninguna no viola NADA: un gate mal escrito en un assert falla **abierto**. Es aviso y
  no error porque fallar cerrado admite formas que un lector léxico no puede probar ausentes (una FK
  a un registro, un trigger), y un rojo falso aquí es un módulo correcto que no puede publicar.

> **Se lee la CADENA, no el fichero.** Las migraciones son append-only: `verifactu/010` sigue
> creando la tabla con la CHECK anónima y `012` la retira. Un lector por fichero pondría en rojo
> justo al módulo que hizo el trabajo — el falso positivo con el que un gate se convierte en ruido
> que todo el mundo silencia. Por eso se replican las migraciones **en el orden que declara el
> manifest** y se juzga el estado final.
>
> **Trinquete, no golpe.** El barrido de los 27 repos (`origin/main`, 01/09/2026) encuentra el
> patrón en 5 módulos: `verifactu` (ya arreglado) y otros cuatro. Esos cuatro ficheros entraron en
> `GRANDFATHERED` uno a uno **con su issue** (appointments#103, reservations#42, services#91,
> tables#76): **avisan** en cada `erplora validate` —nunca en silencio— y no ponen en rojo un repo
> publicado por una regla escrita hoy. La lista solo puede ENCOGER, hay un test que fija su
> contenido exacto, y la tolerancia es por **fichero**: una tabla guardia nueva, incluso en uno de
> esos módulos, nace en error.
>
> 🎯 **La lista está VACÍA desde el 05/09/2026 y el trinquete llegó al final: no queda deuda.**
> `appointments` había salido antes con appointments#103; el 05/09 salieron las tres últimas:
> `reservations` (reservations#42, migración 004), `tables` (tables#76, migración 011) y
> `services` (services#91, migración 016). Cada `__gate` de la flota se juzga ya igual, sin excepciones. El
> mecanismo se queda —vacío— porque es lo que hace la regla adoptable la PRÓXIMA vez: el día que
> aparezca un repo con el defecto, se le da una entrada con su issue en vez de un repo en rojo. Su
> comportamiento lo prueba una entrada **sintética** que inyectan los tests, así que la guarda
> sigue ejercitándose con la lista real vacía.

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
sobre `origin/main` de los 25 repos el día que aterrizó: **275 de 298 controles** declaraban `fill`
y **ninguno** declaraba `mode="md"`.

**No es una copia del escáner del hub.** El hub lee `.vue`, donde una etiqueta acaba en el primer
`>`. Una plantilla Lit no: `@ionChange=${(e: any) => this.patch({ id: e.target.value })}` mete `>` y
`{}` **dentro** de la etiqueta. Cortar en el primer `>` leería como ausente todo atributo posterior
a una arrow function —`mode="md"` incluido— y delataría un control que está bien. Un falso positivo
aquí pone en rojo el gate de un módulo correcto, que es peor que el bug que se persigue.

**Trinquete, no big-bang.** Poner esto en error de golpe deja los 25 repos en rojo el mismo día por
algo que no tiene que ver con lo que cada uno estaba publicando — y un gate que bloquea todo se
apaga, no se obedece. Así que el pase es **por fichero Y por número** (`FILL_GRANDFATHERED`): los
controles que un fichero tiene hoy se toleran, **uno más no**, y un componente nuevo no hereda nada.
La lista **solo puede encoger**; la vacía el barrido de ERPlora/pm#152, módulo a módulo.

De 275 controles en 45 ficheros (22 módulos) va por **136 en 21 ficheros (12 módulos)**. `customers`,
`inventory`, `kitchen`, `pricing`, `printing`, `staff`, `tasks` y `whatsapp_inbox` están limpios y
**fuera de la lista**: lo que se toleraba ahora es error, así que una recaída se ve. Un módulo sale
cuando **todo** su `ui/` declara `mode="md"` — nunca bajando el número para que encaje un arreglo a
medias, que es como se abuelaría la mitad que sigue rota.

**Con alarma sobre su propia premisa.** `test/validate-ionic-fill.test.mjs` lo comprueba contra la
dependencia (no contra una copia): el día que Ionic pinte `fill` en `ios`, falla y dice que la
comprobación **sobra**. `test/canonical-mirrors.test.mjs` hace lo propio con el pin `mode: 'ios'` del
shell, y además corre este escáner sobre las vistas `.vue` del hub —limpias por su propio guard— para
que las dos puertas no digan cosas distintas del mismo marcado. Un chequeo que sobrevive a su causa
es peor que no tenerlo: enseña que el gate pide cosas que dan igual.

## El `color=` que no cruza el shadow root (module-toolkit#273)

`src/validate-ionic-color.mjs`. Ionic da color en dos mitades: el componente pone
`.ion-color .ion-color-<x>` en su host y pinta desde `--ion-color-base`, pero **quien da valor** a
`--ion-color-base` es la regla **global** `.ion-color-<x>` de `@ionic/core/css/core.css`, que no casa
con elementos dentro de un shadow tree. Cada pantalla de un módulo es un Web Component Lit con su
shadow root, así que un `ion-button`/`ion-badge`/`ion-chip` relleno sale **invisible** (texto blanco
sobre fondo transparente) y un botón `outline`, un `ion-icon` o un `ion-note` pierde el color que
prometía. Pasó en «Listo» de cocina (kitchen#42) y en «Cerrar caja» (cash_register#90), y cada vez se
arregló ese botón solo.

La puerta rechaza `color="…"`, `color=${…}` y `.color=${…}` en cualquier `ion-*` de `ui/` (no mira
`dist/`, `node_modules/` ni los `*.test.ts`, que pueden citar el caso). Lee la etiqueta Lit entera
—multilínea y con `>` dentro de `${…}`— con el mismo lector que la del `fill`. El arreglo por uso:
quitar `color=` y declarar en el CSS del componente `--background`/`--background-activated`/
`--background-hover`/`--color` desde el token (`var(--ion-color-danger, #c5000f)`): las custom
properties sí heredan a través del límite.

**Trinquete, igual que el del `fill`** (`COLOR_GRANDFATHERED`, por fichero y número): medido sobre
`origin/main` de los 27 repos el 2026-09-23, **89 usos en 35 ficheros (17 módulos)** se toleran; uno
más no, un componente nuevo no hereda nada, la lista solo encoge (la vacía el barrido de ERPlora/pm#392) y una entrada que ya no cubre nada
**falla** el gate del propio módulo (ese PR de dos líneas va primero). `cash_register` está limpio y
fuera. La premisa está anclada a la dependencia en `test/validate-ionic-color.test.mjs`: el día que
Ionic deje de depender de `--ion-color-base`, falla y dice que la comprobación sobra.

## El `class=${…}` que borra las clases de Ionic (module-toolkit#303)

`src/validate-ionic-class.mjs`. Un binding de atributo Lit sobre `class` —`class=${expr}` o una
interpolación dentro del valor (`class="a ${expr}"`)— se escribe con `setAttribute('class', …)`: el
atributo **entero**, en cada cambio (igual `.className=${…}`). Stencil solo vuelve a poner las clases
de host que cambia su propio render, así que las que estampó una vez —`ion-activatable` (la que busca
el tap-click para poner `ion-activated`), `ion-focusable`, `hydrated`, `ios`— se pierden: el botón se
sigue viendo, pero deja de iluminarse al pulsarlo y pierde el anillo de foco. Pasó en el URGENTE de
cocina (kitchen#88) y en el descuento de sales (sales#358).

La puerta rechaza esas formas en cualquier `ion-*` de `ui/` (mismo lector de etiqueta multilínea que
`fill`/`color`, mismas exclusiones). Lo único que pasa es `class="fija ${classMap({…})}"` o
`class=${classMap({…})}`: `classMap` solo toca las claves que declara.

**Trinquete, igual que el de `color`** (`CLASS_GRANDFATHERED`): medido sobre `origin/main` de los 27
repos el 2026-09-24, **4 usos en 4 ficheros** (`customers`, `kitchen`, `pricing` —un `ion-input`
multilínea que un grep de una línea no veía— y `sales`) se toleraban; `kitchen` salió con kitchen#89
(techo 3/3); cada módulo lo arregla en su repo
y borra antes su línea. La premisa está anclada a `@ionic/core` en `test/validate-ionic-class.test.mjs`.

## El suelo de core que el módulo pide (module-toolkit#201)

Los `ok-*` con los que se pinta un módulo son **los del shell**, no los que lleva su bundle: el shell
los define al arrancar y el `define()` horneado pierde en silencio (ADR-0133 §verificación 2). Y la
imagen del hub instala `@erplora/outfitkit@latest` en cada build (`hub/docker/Dockerfile`, con
cachebust), así que el checkout del autor va casi siempre **por delante** de la flota. Publicar
entonces es publicar una pantalla que ningún hub sabe pintar — pasó dos veces en cuatro días
(hub#1547 y sales#259) y en las dos lo descubrió el cliente, días después.

La mitad que **decide** ya existía: `compatibility.min_erplora_version` en el manifest, que el hub
**aplica** al instalar desde hub#521 (por debajo de ese core rechaza la instalación con un mensaje
accionable en vez de instalar algo a medias). Faltaba la que la **reclama**, y es
`src/validate-outfitkit-floor.mjs`.

**Trinquete, no big bang** — y el reparto es lo que lo hace desplegable. Hay dos casos y no pesan lo
mismo:

1. El manifest **declara** un suelo y el sello es más nuevo que el OutfitKit que ese suelo lleva. Es
   una afirmación del autor demostrablemente falsa → **error siempre**.
2. El manifest **no declara nada** —que significa «cualquier hub»— y el sello es más nuevo que el
   OutfitKit del hub más nuevo que existe → **aviso en `validate`, error en `erplora pack`**.

Por qué el (2) no puede ser rojo en `validate`, **medido**: el sello no lo elige el autor.
`stampOutfitkit()` lo resuelve desde `node_modules/@erplora/outfitkit`, que aquí es
`file:../outfitkit` —el checkout de desarrollo compartido, que cuando esto se midió iba por 0.1.59
con npm en 0.1.65, o sea por delante de la flota (0.1.58) *por la propia premisa*— y `validate`
obliga a reconstruir en cuanto se toca `ui/**` (`checkBundleArtifact`). Sumado: **27 de 27** módulos
se pondrían rojos en su siguiente PR de UI, por la cadencia de release del hub y no por nada que hicieran sus autores. Un gate que para
a todo el mundo se apaga, no se obedece — es el MISMO reparto que hace `bundle-freshness.mjs` al lado
(con sello → error; sin sello → aviso).

Donde sí bloquea es en `erplora pack`, la puerta del marketplace: construye y prueba contra lo que
quieras, pero no **publicas** una pantalla que ningún hub sabe pintar. Es el modelo de cualquier
tienda de aplicaciones.

🔴 **Y `pack` construye ANTES de validar, no al revés.** No es un detalle de estilo: `build`
reescribe `dist/` —el bundle y `dist/outfitkit.json`—, así que validar primero es juzgar un
artefacto que la propia orden está a punto de sustituir. Con el orden viejo, `customers` (sello
commiteado 0.1.52) salía con `EXIT=0`, sin un aviso, y el zip viajaba con 0.1.59: le pasaba a **25
de los 27** módulos. Y no era solo el sello — `validate` comprueba también que el bundle sea
CSP-safe, y comprobaba el viejo mientras empaquetaba el nuevo. La regla, en una frase: **se valida
lo que se publica, no lo que había en el árbol.** El precio del orden nuevo se paga en `pack.mjs`:
si `build` se cae, se le pregunta al validador por qué, para que un manifest roto siga fallando con
«id inválido» y no con «no encuentro entry de WC».

Y siempre hay salida de una línea, **con su precio dicho**: declarar `min_erplora_version` con el hub
que sí lo lleva —o, si no lo lleva ninguno, con el **siguiente** tag—, sabiendo que hub#521 hará que
el módulo deje de instalarse en los hubs por debajo hasta que actualicen; o reconstruir más abajo,
sabiendo que eso obliga a mover `../outfitkit`, que es compartido.

### La fuente real: se le pregunta al hub (module-toolkit#203)

Todo lo de arriba compara contra un número **deducido** (la tabla `HUB_OUTFITKIT` de la sección
siguiente). Desde **ERPlora/hub#1588** no hace falta deducir: el build del shell emite
`dist/outfitkit-version.json`, el `docker/Dockerfile` lo copia a `/app/web/outfitkit-version.json`
—y **para el build** si falta o no cuadra (`OUTFITKIT_STAMP_MISSING` / `OUTFITKIT_STAMP_MISMATCH`)—
y la capa estática del runtime lo sirve. O sea que cualquier hub vivo contesta:

```console
$ curl https://<slug>.erplora.com/outfitkit-version.json
{ "outfitkit": "0.1.65", "hub": "1.1.14" }
```

`src/hub-outfitkit-source.mjs` lee ese dato y `hubOutfitkitTable()` lo mete en la tabla: la fila
real **sustituye** a la derivada de ese mismo tag. Con eso la comparación deja de ser una conjetura,
y eso cambia el resultado **en las dos direcciones**:

- **Cierra el agujero.** Un suelo declarado sobre un tag que la tabla no conocía se dejaba pasar con
  un aviso («añade el tag a `HUB_OUTFITKIT` cuando se publique») y el módulo se **publicaba**
  prometiendo un hub en el que no cabe. Si ese tag es el que contestó, ahora se comprueba de verdad
  y se **rechaza** (caso 1 del trinquete: afirmación del autor demostrablemente falsa).
- **Quita la falsa alarma.** La derivación va por detrás de la realidad —la imagen instala
  `@latest` en cada build y la tabla anota lo último publicado **antes** del tag—, así que llamaba
  «más nuevo que todo hub» a horneados perfectamente pintables, y eso bloqueaba `pack` sin motivo.

| Variable | Qué hace |
|---|---|
| `ERPLORA_HUB_URL` | Base del hub al que preguntar (`https://acme.erplora.com`). **Opt-in**: sin ella no se toca la red. |
| `ERPLORA_HUB_OUTFITKIT_CACHE` | Dónde se recuerda la última lectura real. Por defecto `~/.erplora/hub-outfitkit.json`; existe para que los tests y CI no escriban en el `~` de nadie. |

🔴 **Degradar siempre se puede; bloquear por una degradación, nunca.** Sin `ERPLORA_HUB_URL`, sin
red, o contra un hub anterior a #1588, `readHubOutfitkit()` devuelve `row: null` y **todo se comporta
exactamente como antes**, con la tabla derivada. Lo que sí hace siempre es **decirlo** por `⚠`: un
control que se ablanda en silencio deja de controlar sin que nadie se entere. Dos detalles que
costaron su test:

- La capa estática del hub tiene **fallback SPA** (`with_static_frontend`), así que un hub anterior
  a #1588 contesta esta ruta con su `index.html` y un **200 OK**, no un 404. Por eso se parsea el
  cuerpo y no se cree el código de estado.
- La última lectura real se **cachea**, y la cache pasa por el mismo parser que el cable: un número
  donde iba una versión (`{"outfitkit": 165}`) compararía como `[165]`, es decir más nuevo que todo
  lo publicado nunca, y un error ajeno se convertiría en un bloqueo nuestro.
- Esa cache se usa **sin `ERPLORA_HUB_URL` y sin avisar** —es lo correcto: no haber configurado un
  hub no es un fallo—, pero puede subir un aviso a **error** en `pack`. Por eso el mensaje dice de
  dónde sale **cada número que cita**, fila a fila: *medido* en el hub que contestó, *recordado en
  cache* (y puede haberse quedado atrás), o *deducido por la fecha del tag*. Firmar como medido un
  número que no lo es —el techo derivado cuando el hub que contestó era uno **viejo**— deja al autor
  discutiendo con una conjetura creyendo que discute con un hecho.

Y el trinquete de #201 sigue en pie: con número real, `validate` sigue **avisando** y quien bloquea
sigue siendo `pack`, porque el sello lo pone `../outfitkit` y no el autor.

### La tabla `HUB_OUTFITKIT`, el camino degradado

`HUB_OUTFITKIT` (en ese mismo fichero) dice qué OutfitKit lleva cada tag del hub, **deducido por
fecha**: como el Dockerfile pide `@latest` con cachebust, la versión de una imagen sin sello solo se
deduce de **cuándo** se construyó. Cada fila es «el último `@erplora/outfitkit` publicado en npm antes
de crearse el tag»; `built_at` es la fecha de creación del tag en `ERPlora/hub`.

Desde module-toolkit#203 **ya no es la respuesta por defecto**: es lo que queda cuando no hay hub al
que preguntar. Y sigue haciendo falta mientras quede algún hub vivo sin el sello, que son cada vez
menos: hub#1588 salió en un tag con **v1.1.14** (06/09/2026) y todos los posteriores lo llevan, así
que hoy el único hub que no contesta esa ruta es uno por debajo de esa versión.

- **Se comprueba contra un positivo conocido:** la fila de `1.1.13` → `0.1.58` es la que sales#265
  midió a mano por otro camino, y `test/validate-outfitkit-floor.test.mjs` la clava para que deje de
  cuadrar en voz alta el día que la derivación se tuerza.
- **Es el séptimo espejo del hub, con su alarma.** `canonical-mirrors.test.mjs` lee los TAGS del hub
  vecino (refs, nunca el working tree) y exige tres cosas: que cada fila nombre un tag que existe de
  verdad con su fecha de creación; que la **columna de OutfitKit** vuelva a salir de su propia regla
  de derivación, re-consultada contra npm (skip honesto sin red) — sin eso, falsear una fila
  intermedia pasaba en verde, y esa columna es justo lo que el control responde; y que el tag más
  nuevo esté en la tabla, preguntando por **todos** los tags de release y no solo por la línea `1.1`
  (si no, el día que salga `v1.2.0` la alarma seguiría verde apuntando a `v1.1.13`). Así, «mantenerla es parte
  de publicar el hub» deja de ser memoria y pasa a ser mecanismo: sin la fila, el control mediría los
  módulos contra una flota que ya no existe. Skip honesto si no hay hub al lado, como los otros seis.
- **La fila la escribe una máquina, no una persona (module-toolkit#271).** La regla es mecánica, así
  que `npm run hub-outfitkit-rows -- --write` (con el hub al lado o `--hub <checkout>`, tags reales
  con `git fetch --tags`) deriva las filas de los tags que faltan con **la misma función** que el
  espejo re-ejecuta (`src/hub-outfitkit-rows.mjs`) y las escribe en su sitio; sin `--write` solo
  informa. Y una fila que falta **ya no bloquea las PRs del hub**: en un `pull_request` la action
  `check-canonical-mirrors` pone `ERPLORA_HUB_ROW_LAG=warn`, imprime la fila derivada como aviso y
  los dos espejos de «falta la fila» se saltan diciéndolo. La copia va por detrás de una release, y
  eso no es culpa de esa PR (el mismo reparto que hub#1296). En el job del tag
  (`build-hub.yml`), que es donde la fila vence, y en local sigue en rojo. Una fila **mal** puesta
  falla en todas partes.
- **No es la fuente de verdad.** Quien SABE la versión es el hub, y desde hub#1588 la publica: ver
  la sección anterior. Cuando el hub contesta, su fila gana.

## Los espejos canónicos: contra QUÉ se comparan (module-toolkit#61 y #90)

El toolkit copia a mano ocho cosas cuya autoridad vive en `ERPlora/hub` (el esquema del manifest,
el **esquema del documento de flujo** (`schemas/flow.schema.json`, module-toolkit#209),
`BRIDGE_FUNCTIONS`, la política de claves desconocidas, `CORE_QUERIES`, las migraciones abueladas,
el pin `mode: 'ios'` del shell y la **superficie congelada del kernel**).
`test/canonical-mirrors.test.mjs` las compara byte a byte, y `test/hub-mirror.mjs` es la puerta que
decide **de dónde sale el original**. Tres fuentes, por orden:

| Fuente | Cómo lee | Si falta el fichero |
|---|---|---|
| `ERPLORA_HUB_DIR` | **del disco**, tal cual | **ERROR** — la promesa «compara contra ESTE hub» se aceptó |
| el checkout vecino `../hub` | `git archive origin/develop` — **nunca** su árbol de trabajo | **ERROR** nombrando el ref (`git fetch` y otra vuelta) |
| no hay hub | — | **skip** explícito, dicho por su nombre |

**Por qué el vecino se lee por ref y no del disco (#90).** Leído del disco, el original es la rama
en la que otro dejó su checkout, con lo que tenga sin commitear. El 28/08/2026,
`schemas/module.schema.json` era **idéntico** a `origin/develop` y el espejo fallaba igual, porque
el checkout vecino estaba en `fix/blueprint-media-auth`. Tres workers seguidos lo archivaron como
«fallo preexistente en `main`, no es mío». Un guard que da falsas alarmas se silencia, y entonces
ya no es un guard.

**Por qué el declarado SÍ lee el disco.** Quien declara `ERPLORA_HUB_DIR` es CI, y ahí el checkout
en disco **es** lo que se quiere comprobar: el del pull request.

**Suena en los dos lados.** Desde el hub, `.github/actions/check-canonical-mirrors` (lo llama
`canonical-mirrors.yml` del hub). Y desde aquí: el CI de este repo ya se traía el hub entero al
runner para resolver `module-sdk@develop` (ERPlora/hub#1097) y los espejos se saltaban **al lado
del checkout que necesitaban** — `skipped 7`, en verde, en cada PR. Ahora ese paso exporta
`ERPLORA_HUB_DIR` y se comparan de verdad: **una copia vendorizada que derive de `develop` pone en
rojo el PR que la traía**.

### La superficie CONGELADA del kernel, vendorizada (module-toolkit#115)

`contracts/kernel/` de este repo es la copia byte a byte de `contracts/kernel/` del hub: los
**cinco snapshots** que la ADR **«El Hub se CIERRA como KERNEL»** (2026-08-27) congela —rutas
HTTP/WS, motor declarativo, contrato del guest WASM, tablas de sistema y tipos públicos de
`@erplora/module-sdk`—. No se escriben a mano en ningún lado: los **genera** el hub desde su propio
código.

**El `README.md` del hub NO se espeja** (module-toolkit#121). Es prosa dirigida a quien trabaja
*en el hub* —invocaciones de `cargo`, rutas `crates/runtime/tests/…`, nombres de workflow— que aquí
ni existe ni se puede ejecutar, y que ningún módulo publicado consume. Espejarlo convertía **cada
edición de documentación del hub** en un rojo de este repositorio: hub#1263 y hub#1265 no movieron
ni una ruta, ni el motor, ni el guest, ni las tablas, ni el SDK, y aun así rompieron el espejo. Una
alarma que salta por prosa se acaba silenciando, y entonces ya no avisa del `routes.snapshot` que sí
importa. Queda **enumerado** (`KERNEL_CONTRACT_NOT_MIRRORED`), no simplemente fuera: un fichero sin
nombrar en el directorio del hub es un fichero sin vigilar.

Se vendorizan por lo mismo que el esquema del manifest: el gate de los **27** repos de módulo no
puede hacer checkout de `ERPlora/hub` —el `GITHUB_TOKEN` de un repo de módulo no alcanza otro repo
privado—, así que la superficie contra la que se construye un módulo tiene que poder leerse aquí. Y
por lo mismo llevan espejo: uno por fichero (el `diff` dice **cuál** se movió) más uno sobre el
**conjunto**, para que el día que el hub congele una sexta superficie no pase inadvertida por no
estar en la lista.

**Refrescarlas es un solo comando**, nunca un `cp` a mano:

```sh
npm run sync-mirrors     # las 7 copias, desde la MISMA fuente que usan los espejos
npm run sync-schema      # alias histórico del anterior
```

Sin hub que copiar —o con un hub que no trae un fichero— el script **falla nombrándolo**: copiar
cero ficheros y salir en verde dejaría las copias tan viejas como estaban.

**Y una copia no se mergea sola.** Mover una superficie espejada son **dos** PRs —la del hub y la de
aquí— y cada lado está rojo hasta que aterriza el otro: el `canonical-mirrors.yml` del hub lee
`module-toolkit@main` y el CI de este repo lee `hub@develop`. El nudo se declara con una línea
`Depends-On: ERPlora/<repo>#<N>` en el cuerpo de cada PR —la sintaxis es la de Zuul, no se inventa
ninguna— y quien lo honra es `merge-pr.sh` (ERPlora/pm#181), con un orden que no es preferencia:
**primero el canónico** (el hub), después la copia. La copia no lleva dispensa ninguna — su CI se
relanza y tiene que salir verde por su cuenta, que es además la prueba de que la dispensa del
canónico estaba justificada. Quien abre la puerta nombra la copia en `MERGE_PR_PAIR`, y tiene que
casar con el `Depends-On:` de los dos lados. ⚠️ Esa línea se lee como **markdown**: escrita dentro
de un bloque de código o entre acentos simples no declara nada (ERPlora/pm#317).

## Las automatizaciones de fábrica del módulo (`flows/`) — module-toolkit#209

Un módulo puede traer sus propias automatizaciones: el flujo ya montado que el dueño solo tiene que
encender. Viven en `flows/`, **viajan en el ZIP** (`INCLUDE`) y `erplora validate` las juzga.

**Por qué hizo falta.** Antes ni viajaban ni las miraba nadie: `pack` dejaba la carpeta fuera, así
que la única puerta al hub era una **copia a mano** de la plantilla en la galería del módulo `flows`
(`ui/lib/templates.ts`). Una copia de un documento que nada valida se queda atrás: el 06/09 se
quedó atrás **tres veces en un solo día**, y una sola resincronización costó 23,2 M de tokens.

**El contrato es una CONVENCIÓN DE CARPETA, no una clave del manifest** — igual que `locales/`. Es
deliberado: la raíz del manifest es un contrato **CERRADO** (`additionalProperties: false`,
ADR-0286), así que una clave `flows` nueva le pondría a cada módulo que la declarase un **suelo de
versión de hub** y haría **avisar a toda la flota anterior**. Por carpeta, un módulo publica hoy sus
plantillas —sin suelo y sin un solo aviso— y el día que aterrice [ERPlora/hub#1611] aparecen solas,
sin republicar nada.

```
flows/
  <family>.en.flow.json        documento del flujo, idioma FUENTE            OBLIGATORIO
  <family>.es.flow.json        su traducción (ADR-0055/0199)                 OBLIGATORIO
  <family>.<lang>.flow.json    más idiomas                                   opcional
  <family>.grants.json         { "grants": [ { kind, value }, … ], "_…": }   OBLIGATORIO
  <family>.requires.json       { "modules": { "<id>": "<SemVer>" }, "_…": }  opcional
  *.md                         documentación de la carpeta                   opcional
```

- `<family>`: `^[a-z][a-z0-9-]*$`. `<lang>`: `^[a-z]{2}$`. La carpeta es **plana**: ni subcarpetas
  ni ficheros sueltos — lo que nadie va a abrir no viaja.
- El documento cumple `schemas/flow.schema.json` (raíz **cerrada**, `schema_version: 1`, `steps` no
  vacío, cada paso con `id` único y un `kind` del vocabulario **congelado**). Nada de eso se teclea
  en el validador: se **lee** del esquema vendorizado, que el espejo canónico ata al del hub.
- Cada trigger cumple `$defs/trigger` del mismo esquema: objeto **cerrado**, `kind` obligatorio y
  del vocabulario **congelado** (`event`, `cron`, `at`, `manual`). Un trigger que el hub no sabe
  leer se rechaza aquí, no en el hub de un cliente.
- **Todos los idiomas de una familia declaran los mismos pasos, en el mismo orden, y el MISMO
  trigger entero** —hasta el `filter` y el `input`—: un trigger no lleva prosa, así que no hay nada
  ahí que una traducción pueda cambiar legítimamente. Si el `filter` deriva, el hub en español
  contesta a mensajes que el inglés ignora y **nada lo dice**.
- Y **cada paso es la misma MAQUINARIA en todos los idiomas**: una traducción solo cambia la prosa
  del paso —`prompt`, `vars`, `params`, `body`, `headers`, `title`, `summary`, `template`
  (`PROSE_STEP_KEYS`)— y nada más. `kind`, `command`, `query`, `tools`, `when`, `channel`, `to`,
  `policy`, `max_iters`… tienen que coincidir, o el `es` es otra automatización con el mismo nombre
  (medido en `whatsapp_inbox`: entre `en` y `es` solo difieren `prompt` y `vars`).
- El **suelo de versión** de `requires.json` es **por plantilla**, y a propósito NO es el
  `depends_on` del módulo: `whatsapp_inbox` fija `appointments >= 1.1.69` para su plantilla y su
  `depends_on` es solo `["customers"]` — la plantilla es opcional, el módulo funciona sin ella.

**Lo que esta puerta NO juzga**: la semántica de la automatización (si los `grants` cubren lo que
los pasos usan, si el prompt ordena una herramienta que el módulo tenga). Eso necesita los módulos
vecinos y vive en la batería del propio módulo (`tests/flow_templates.test.py`).

⚠️ **Y `flows/**` tiene que estar en las `paths:` del `release.yml` del repo del módulo** (el stub
de abajo ya lo lleva). Sin ella, un merge que solo toca una plantilla no sube versión y la plantilla
no llega a ningún hub — el mismo modo de fallo que ya documentan las líneas de `locales/**`.
`erplora validate` lo **avisa** (no lo pone en rojo: un error ahí tumbaría todas las PRs abiertas
del único módulo que hoy trae plantillas, y una guarda que bloquea es una guarda que se apaga).
Sin `release.yml` a la vista —el scaffold, un directorio temporal— se calla: avisar de algo sobre lo
que el autor no puede actuar es el ruido que enseña a ignorar el aviso que sí importa.

## Los tests que el módulo ya tenía

Un repo de módulo trae sus propios tests y, hasta module-toolkit#50/#55/#74/#146, el gate **no
corría ninguno**: se paraba en `erplora validate`. Se escribían, pasaban en local, y romper uno
mergeaba en verde. `erplora test` cierra las tres familias, con la misma regla en todas:

| Familia | Qué recoge | Cómo se corre |
|---|---|---|
| Baterías | cualquier `tests/**/*.test.py` o `*.test.sh` | el intérprete que toque; las que necesitan Postgres (por nombre `.pg.`/`.postgres.` **o porque leen el contenedor**) usan `ERPLORA_TEST_PG_CONTAINER` |
| TypeScript | `ui/**/*.test.ts` — los Web Components, donde vive casi toda la lógica de pantalla | vitest + happy-dom, con la **config del toolkit** (`src/vitest.module.config.mjs`) |
| Rust | `handler/**/*.rs` con `#[cfg(test)]` — la lógica de negocio de un módulo Tier 2 | `cargo test` sobre el crate del handler; fuera del monorepo necesita un checkout del hub en `ERPLORA_HUB_DIR` (§ *Los tests del handler*) |

### Las migraciones te las da el entorno: `ERPLORA_MIGRATION_FILES`

Una batería de Postgres **no tiene que releer el manifest** para saber qué migraciones aplicar.
Junto a `ERPLORA_TEST_PG_CONTAINER`, `erplora test` publica en el entorno de **cada** batería la
variable **`ERPLORA_MIGRATION_FILES`**: las rutas **ya resueltas**, **una por línea** y **en el
orden del manifest**, relativas a la raíz del módulo (`MODULE_DIR`).

Lo importante es que aplana **las dos formas** en las que se puede declarar una migración — la
string suelta y la forma objeto `{ "file", "kind", "since" }`, que es la única manera de declarar un
`contract` (hub#542). Así se lee en una batería nueva:

```python
MIGRATIONS = [p for p in os.environ["ERPLORA_MIGRATION_FILES"].splitlines() if p]
for rel in MIGRATIONS:
    psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
```

Y así **no**, aunque sea lo que hacen todavía la mayoría de las baterías publicadas:

```python
for rel in MANIFEST["migrations"]["postgres"]:      # ← solo entiende la forma string
    psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
```

Ese bucle revienta con `TypeError: unsupported operand type(s) for /: 'PosixPath' and 'dict'` en
cuanto el módulo declara su primer `contract`, y revienta **antes** de probar nada. Ya pasó en
ERPlora/appointments#115, que tuvo que tocar 15 baterías de una vez. Por eso `erplora validate`
avisa (`[battery-migrations]`) de cada bucle que aún itera el manifest crudo, y lo sube a **error**
en los módulos que ya declaran alguna migración con la forma objeto: ahí la batería no está en
riesgo de romperse, ya está rota (module-toolkit#180).

Tres reglas, y las tres son el motivo de que esto sea código y no tres líneas de YAML:

1. **El descubrimiento vive aquí, una sola vez.** `--list` enumera exactamente lo que se va a
   correr, y el gate pregunta al toolkit en vez de reimplementar la regla en YAML — que es
   literalmente como pasó module-toolkit#55.
2. **La red al revés.** Un fichero que parece un test y que ningún patrón recoge —un `.py`/`.sh`
   suelto en `tests/`, un `.test.ts`/`.spec.ts` fuera de `ui/`— **tumba el gate por su nombre**. Un
   test invisible es peor que no tener test: da la confianza sin hacer la comprobación.
3. **Lo que no corre se NOMBRA, nunca se cuenta como verde.** Una batería de Postgres sin
   contenedor, o unos tests de TypeScript sin los paquetes que necesitan, salen como «sin correr»
   con el motivo. Un `*.postgres.test.py` sale con 0 cuando no alcanza el contenedor, así que
   «verde» y «no se ejecutó» son idénticos desde fuera — y esa distinción es todo el asunto.
4. **El contrato no es «exit 0», es «se ejecutaron».** Tras un vitest en verde se lee del resumen
   cuántos ficheros recogió y se compara con los que `--list` prometió: si recogió menos, **falla**
   (es la deriva que reabriría #55 por el lado de la config, con las dos mitades diciendo que todo
   fue bien); si se saltó alguno entero (`describe.skip`), sale «sin correr» por su nombre; y un
   0 del que no se pueda leer ese resumen tampoco pasa. Hoy **ninguno** de los 212 ficheros se
   salta a sí mismo — la alarma se instala con la casa limpia, para que salte con el primero.

**La config de vitest la pone el toolkit**, no el módulo, porque el repo del módulo está limpio a
propósito: 23 de los 27 no llevan `tsconfig.json` (sin él, `@state()` de Lit ni siquiera compila) y
los 4 que lo llevan hacen `extends: '../../tsconfig.json'`, una ruta que solo existe dentro del
workspace de desarrollo (con ella, el transform muere y el módulo recoge **cero** tests). Los dos
casos están reproducidos sobre un checkout limpio en `test/run-vitest.test.mjs`.

**El paquete que faltaba, y cómo dejó de faltar.** Montar un WC de módulo necesita cinco paquetes:
`vitest`, `happy-dom`, `lit`, `@ionic/core` y `@erplora/outfitkit` salen de npm y el gate los
instala; `@erplora/module-sdk` vive en `ERPlora/hub` —privado y sin publicar— y en un runner no hay
credencial que lo alcance. Durante un tiempo eso dejó **177 de 212 ficheros** declarados «sin
correr», con el paquete que falta por nombre y el gate en verde.
[ERPlora/hub#1097](https://github.com/ERPlora/hub/issues/1097) lo cerró **sin publicar nada**: el
hub comparte una composite action con la organización, GitHub la resuelve **sin credencial** y al
resolverla deja el repo entero en disco. Desde entonces se corren todos, y «sin correr» dejó de ser
un estado tolerado: un `.test.ts` que no se ejecuta **falla**.

Y el estado de partida, medido antes de tocar nada (`npx vitest run` en `modules-workspace`):
**212 ficheros · 2.290 tests · todos en verde**. No hay rojos preexistentes que repartir por módulo
—al revés que en `outfitkit#66`, donde eran 9 ficheros—, así que esto entra de golpe y no en
trinquete: no hace falta ningún `GRANDFATHERED`.


### Los tests del handler (`cargo test`) — module-toolkit#146

La tercera familia, y la última que el gate no corría. Un módulo Tier 2 lleva su lógica de negocio
en `handler/src/*.rs`, con sus `#[cfg(test)] mod tests` al lado. `erplora validate` **compila** el
handler (#135) y `erplora build` se niega a publicar un `dist/handler.wasm` desfasado (#26): el
**artefacto** estaba vigilado. Lo que el artefacto **hace**, no. Medido el 2026-09-01 sobre
`origin/main` de los 22 repos con handler: **21 módulos, 928 tests, y la CI ejecutaba cero**.

Lo que costó, con nombre: en [ERPlora/kitchen#63](https://github.com/ERPlora/kitchen/issues/63) el
bug entero era una línea del handler que construía la cabecera de la comanda sin `waiter_id`, así
que cada ronda llegaba al KDS sin camarero. El arreglo trae dos tests en Rust que van del rojo al
verde… y no los corría nadie más que quien los escribió.

**Por qué no podía correr, y por qué ya sí.** Los 22 handlers alcanzan el `erplora-guest-sdk` del
hub **por ruta relativa** (`../../../../hub/crates/guest-sdk`): cuatro niveles por encima de
`handler/`, un layout que solo existe en el monorepo. En el repo de un módulo no hay checkout del
`ERPlora/hub` privado ni credencial para hacerlo — y meter un PAT en 22 repos es una decisión de
seguridad, no un detalle de CI. **No hace falta**: para poder ejecutar la composite action del SDK,
el runner ya se trae el hub ENTERO a disco. Lo que faltaba nunca fue el checkout: era la **forma**.

`src/run-cargo.mjs` la construye — una granja de symlinks en un directorio de scratch que pone el
módulo y el hub a las profundidades que la ruta declarada espera, y le pasa a cargo el manifest *a
través* de ella. No se escribe un byte fuera del scratch, así que las seis ranuras de `ci-runner-1`
no comparten estado mutable. La profundidad se **deriva** de lo que declara el `Cargo.toml`, nunca
se fija en cuatro.

Cuatro alternativas medidas y descartadas, para que no se reabran como idea:

| Alternativa | Por qué no |
|---|---|
| **Copiar** el crate a un sitio cómodo | No compila: los handlers hacen `include_str!("../../module.json")` y de sus schemas. Sobre `kitchen`, dos errores de compilación. |
| `cargo --config 'paths=[…]'` | No funciona: una dependencia `path` tiene que **cargar** antes de que un override la sustituya. Pareció pasar una vez porque el shell había canonicalizado el cwd sobre el monorepo real. |
| **Reescribir** `handler/Cargo.toml` al vuelo | Mutar el checkout bajo test, sobre un fichero que `dist/handler.build.json` hashea — la forma exacta que ya quemó a #31 con `Cargo.lock`. |
| Un job aparte filtrado por `paths: handler/**` | Más barato y **equivocado**: los tests del handler leen `../../module.json` y `../../schemas/*.json`, así que un PR que solo toque el manifest o un schema cambia lo que afirman y el filtro lo saltaría. |

**Coste, medido.** El `target/` del perfil de test de un handler pesa **82 MB** (sobre `kitchen`);
va a `RUNNER_TEMP`, que se recupera con el job, en una máquina cuyo techo es el disco. El paso se
salta entero para un módulo sin tests Rust (`invoice_series` es el único hoy). La toolchain se
instala con rustup (perfil `minimal`) en el `$HOME/.cargo` del runner, que **persiste entre jobs**,
así que se paga una vez; si la descarga muere, sale por `ci-infra.sh` como
`ERPLORA_INFRA_FAILURE` — un disco lleno no puede parecer un módulo roto.

**Y el control, que es lo único que hace creíble lo anterior.** `test/run-cargo.test.mjs` termina en
una pareja que corre un `cargo test` **de verdad** sobre dos handlers de fixture que se diferencian
en UNA aserción: el sano tiene que salir verde y el mutante **rojo**. Además se comprobó sobre el
módulo real: reintroducir kitchen#63 en el `origin/main` de `kitchen` pone el gate en rojo nombrando
`the_ticket_says_which_waiter_fired_it`. Un control que nunca ha visto el positivo es un control que
nadie ha probado.

## La batería contra el kernel REAL (`--against-hub`) — module-toolkit#110

Una batería de Postgres levanta una base de datos desde las migraciones del módulo y comprueba el
SQL ahí, afirmando que «bindea y corre exactamente como lo corre el runtime». Eso es una afirmación
del test, no una propiedad del runtime: el bindeo, los `system_params`, los gates de fila, el
instalador y el `migration_guard` están **reimplementados a mano** en el harness, y coinciden con el
motor solo hasta que alguien toca el motor.

`erplora test <dir> --against-hub` borra la emulación del bucle. Es la mitad «módulo» de la suite de
conformidad del kernel (ADR «El Hub se CIERRA como KERNEL» §5), y la forma es la de Android CTS y la
de `testcontainers`: **el kernel de verdad, arrancado**.

```bash
erplora test modules/sales --against-hub          # ghcr.io/erplora/hub:stable (el canal por defecto)
erplora test modules/sales --against-hub dev      # el canal de integración
erplora test modules/sales --against-hub sha256:… # un digest concreto (lo que hay desplegado)
erplora test modules/sales --against-hub ghcr.io/erplora/hub:1.1.10
```

Qué hace, en orden, y todo con `docker` de línea de comandos (sin SDK, sin driver):

1. `docker pull` de la imagen. Si sale **denegado**, el error escribe el comando exacto que tiene
   que funcionar y el `docker login ghcr.io` que falta — `ghcr.io/erplora/hub` es un paquete
   privado, y un fallo mudo aquí es un verde comprado.
2. Un Postgres efímero (`postgres:18`, el major de producción) en una red propia.
3. El hub, con `HUB_AUTH=dev` + `HUB_DEV_MODE=1`, el módulo montado **de solo lectura** dentro de su
   staging (`HUB_MODULE_CACHE`), y el puerto publicado en uno efímero de `127.0.0.1`.
4. Espera a `/readyz` — el mismo endpoint que vigila el `HEALTHCHECK` de la imagen. Si no llega, el
   error trae la **cola de `docker logs`** del contenedor.
5. Instala el módulo por `POST /api/modules/install`, la puerta real del runtime: corre su
   instalador, su `migration_guard` y su validación de manifest.
6. Corre las baterías de la familia **hub**, que hablan HTTP con ese runtime.
7. **Desmonta todo, pase lo que pase** — y solo lo que creó esta corrida, nunca los contenedores de
   otro agente en la misma máquina. Una corrida que muere dejando el hub en pie lo deja con el
   módulo INSTALADO, y la siguiente «pasa» contra un estado que nadie puso. Vale también para
   `Ctrl+C` y para la cancelación de un job de CI (`SIGINT`/`SIGTERM`/`SIGHUP`): mientras haya
   contenedores el harness escucha esas señales, desmonta y sale con `128+señal` (medido en la
   revisión: sin esto, un `SIGINT` dejaba 2 contenedores y 1 red). Lo único que no se puede
   atrapar es un `SIGKILL`; si pasa, lo que queda se llama `erplora-ah-*` y se borra a mano.

**La familia `hub`.** Una batería es de esta familia por su **nombre** (`tests/*.hub.test.py|.sh`) o
por su **contenido** (lee `ERPLORA_HUB_BASE_URL`) — la misma regla doble que la familia de Postgres,
por el mismo motivo medido en module-toolkit#55. Recibe por entorno:

| Variable | Qué es |
|---|---|
| `ERPLORA_HUB_BASE_URL` / `<ID>_HUB_BASE_URL` | la url del runtime vivo |
| `ERPLORA_HUB_ID` | el `hub_id` con el que el runtime escribe las filas en modo dev (`local`) |
| `ERPLORA_HUB_IMAGE` | la referencia exacta contra la que se está probando |

🔴 **Sin `--against-hub`, una batería de esta familia sale como «sin correr», con su motivo — nunca
como verde.** Es la misma regla que las de Postgres sin contenedor: contarla por buena sería
certificar el módulo contra un hub que nunca arrancó.

⚠️ **Lo que hoy NO alcanza.** `withHubRuntime` monta UN directorio e instala UN módulo, así que un
módulo con `depends_on` arranca sin su cadena y sus baterías mueren en `_require_installed` — es
[module-toolkit#135](https://github.com/ERPlora/module-toolkit/issues/135), **abierta**. Medido
desde el hub el 01/09 y recomprobado el 03/09: **8 de los 11** módulos que entonces tenían batería
caían ahí. Por eso la CI del hub arranca su propio kernel en vez de llamar a esta orden (abajo).

**Qué prueba esto que la emulación no puede.** El fixture de referencia
(`test/fixtures/against-hub/kernel_fixture`) está hecho a propósito de cosas que solo el kernel
enseña: `:new_id`/`:hub_id` los inyecta el runtime y no el payload; un `BIGINT` vuelve por HTTP como
**string** JSON; la misma query bajo otro `X-Hub-Id` no ve **nada**; y un payload que rompe su
propio JSON Schema lo rechaza el runtime, no el test.

**Todavía NO está enganchado al gate compartido**, y se dice en voz alta: `module-gate.yml` corre en
los 27 repos de módulo, que son **privados**, y en el plan Free los secretos de organización no
llegan ahí — no hay credencial con la que hacer `docker pull` de un paquete privado. Engancharlo es
[module-toolkit#112](https://github.com/ERPlora/module-toolkit/issues/112), **abierta**.

Pero «no lo engancha el gate del módulo» no es «no lo corre nadie». Desde **ERPlora/hub#1381** estas
baterías las ejecuta **el hub**, en su `test-hub-modules.yml`, contra un `erplora-server` compilado
de su propio ref —no contra una imagen publicada— y levantando **un hub por módulo**, que es lo que
resuelve la cadena `depends_on` que a `--against-hub` le falta. La lista revisada vive en
`scripts/ci/module-hub-batteries.txt` del hub: hoy **26 baterías de 13 módulos**. Y para que esa
lista no se quede atrás, la otra mitad del cierre está aquí: `src/check-hub-battery-pairing.mjs`
(con su action `check-hub-battery-pairing`, module-toolkit#163 ← ERPlora/hub#1439) pone en rojo la
PR de un módulo que **añade** una batería `*.hub.test.py|sh` sin declararla en el hub en esa misma
pull request.

## El gate de CI de los repos de módulo (ERPlora/pm#107)

El validador **es** el gate: los **27** repos de módulo lo llaman desde aquí. Dos piezas, las dos en
este repo, para que arreglar un agujero no sean 27 PRs:

| Pieza | Qué es |
|---|---|
| `.github/actions/validate-module/action.yml` | composite action: instala `typescript`, levanta el Postgres de scratch, corre `erplora validate <dir> --pg` y después `erplora test <dir>` (baterías propias + tests de TypeScript, instalando el entorno de vitest solo si el módulo trae `.test.ts`) |
| `.github/workflows/module-gate.yml` | workflow **reutilizable** (`workflow_call`) que hace el checkout del repo llamante y ejecuta la action |

El stub que va en cada repo de módulo (`.github/workflows/module-gate.yml`) son ~10 líneas:
`on: pull_request` + `uses: ERPlora/module-toolkit/.github/workflows/module-gate.yml@main`. Además
el `release.yml` de cada módulo pasa a llevar `needs: gate`, así que el bump de versión —que es lo
que hace que el SaaS republique— **no ocurre si el gate está rojo**.

**Por qué aquí y no en cada repo.** El validador es privado y el `GITHUB_TOKEN` de un repo de
módulo no puede hacer checkout de otro repo privado. Una composite action es la única forma que
GitHub resuelve **sin credencial**, con el ajuste *Settings → Actions → Access → accessible from
repositories in the organization* puesto en este repo. Así no hay un PAT del hub/toolkit repartido
por 27 repos, y el gate corre siempre el validador de `main`, no el del día que se escribió el stub.

**Qué NO cubre el gate: producir el artefacto wasm32.** El validador **sí** compila el crate del
handler, pero para el **host** —que es lo que caza un fuente que no compila— y el `cargo test` de
arriba corre también en el host. Lo único que no se hace en CI es el `cargo build --target
wasm32-unknown-unknown`: ese binario lo produce `erplora build` en local, y lo que impide publicar
uno viejo son los guardarraíles de frescura de #26.

🪦 **El motivo que esto tuvo durante meses ya no aplica.** Se decía que los módulos con `handler/`
alcanzan el `guest-sdk` del hub **por ruta relativa** (`../../../../hub/crates/guest-sdk`) y que «en
un runner no hay checkout de `ERPlora/hub`». Lo segundo dejó de ser cierto: para poder resolver la
composite action del `module-sdk`, el runner se trae el **hub entero** a disco (ERPlora/hub#1097), y
eso es exactamente lo que usa module-toolkit#146 para correr los tests Rust. Lo que sigue en pie es
que **un repo de módulo no puede clonar `ERPlora/hub` por su cuenta** —su `GITHUB_TOKEN` no alcanza
otro repo privado— y que repartir un PAT del core por los 27 repos se ha rechazado tres veces.

Lo que queda cubierto sin producir el wasm: que `dist/handler.wasm` **no esté desfasado** respecto al
source Rust del commit (hash de `handler/src` + `Cargo.lock`) y que exporte las funciones que el
manifest enruta. Que el Rust compile se ve en local en cuanto se toca (`erplora build` lo recompila
y se niega a publicar un binario viejo). El validador nunca miente sobre esto: la línea de resumen
dice **`handler WASM SIN VERIFICAR`**.

La salida de fondo sigue siendo consumir el `guest-sdk` **versionado** en vez de por ruta — es la
pieza 1 de [`DECISION-aislamiento-terceros.md`](DECISION-aislamiento-terceros.md).

### La release también vive aquí: `module-release.yml`

La misma decisión, aplicada a la otra mitad del ciclo (module-toolkit#111 · ERPlora/hub#1239). El
bump de versión —el que hace que el SaaS republique— estaba **copiado en los 27 `release.yml`**:
~90 líneas de bucle de reintento y de razonamiento anti-bucle, 27 veces. Ahora es un
`workflow_call` más:

| Pieza | Qué hace |
|---|---|
| `.github/workflows/module-release.yml` | sube el patch de `module.json`/`package.json`, lo empuja a `main` (eso publica) y **avisa a `ERPlora/hub`** con `repository_dispatch: module-published` |

**Por qué el aviso.** `test-hub-modules.yml` del hub clona los ~27 módulos por su estado
**publicado** y los corre contra el runtime. Sin aviso eso solo pasa en la pasada nocturna: el rojo
de hub#1215 lo causó una **release de módulo** (`invoice` v1.2.27, ADR-0405), ningún disparador del
hub podía cazarlo, y aguantó un día entero en rojo con Actions en verde. Con el aviso el rojo sale
**en el momento de publicar** y con el nombre del culpable en el título del run.

El stub de cada repo de módulo (`.github/workflows/release.yml`) queda así:

```yaml
name: Release

on:
  push:
    branches: [main]
    paths: [module.json, 'ui/**', 'queries/**', 'commands/**', 'migrations/**', 'handler/**', 'schemas/**', 'locales/**', 'flows/**', 'dist/**']
  workflow_dispatch:

permissions:
  contents: write          # el reutilizable nunca puede tener MÁS de lo que el llamante concede

# Dos merges seguidos: el segundo ESPERA, no cancela (si no, se perdería un bump).
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  gate:
    if: ${{ !startsWith(github.event.head_commit.message, 'chore(release)') }}
    uses: ERPlora/module-toolkit/.github/workflows/module-gate.yml@main
  release:
    needs: gate
    uses: ERPlora/module-toolkit/.github/workflows/module-release.yml@main
    secrets: inherit       # entrega HUB_DISPATCH_TOKEN
```

🔴 **`HUB_DISPATCH_TOKEN` es un secreto DE REPO, uno por módulo.** El `GITHUB_TOKEN` del repo del
módulo está acotado a ese repo, así que un `repository_dispatch` sobre `ERPlora/hub` con él responde
404; y los secretos **de organización no llegan a repos privados** con la org en plan Free — el
mismo modo de fallo que dejó vacías `MODULES_DEPLOY_KEYS` y `CI_RUNNER_LABEL`. Un secreto ausente
llega como **cadena vacía, no como error**, por eso el paso lo comprueba y **falla en voz alta** en
vez de saltarse el aviso. Ponerlo en los 27:

```bash
# ⚠️ `ls` ya no sirve para recorrerlos: la flota crea sus worktrees DENTRO de `modules/`.
# Un módulo de verdad tiene `.git` como DIRECTORIO; un worktree lo tiene como fichero.
for d in modules-workspace/modules/*/; do
  [ -d "$d.git" ] || continue
  gh secret set HUB_DISPATCH_TOKEN --repo "ERPlora/$(basename "$d")" --body "$TOKEN"
done
```

⚠️ **Si el aviso falló (secreto vacío, 401), NO se relanza el run**: el bump ya está en `main`, así
que la repetición encuentra `main` bumpeado, no publica nada, **se salta el aviso y sale verde** sin
que el hub se haya enterado. El paso lo anota (`::warning::`) y deja la orden para mandarlo a mano:

```bash
printf '{"event_type":"module-published","client_payload":{"module":"<id>","version":"<versión>"}}' \
  | gh api repos/ERPlora/hub/dispatches --input -
```

## Workspace local (lo que existe hoy)

Los **27** módulos viven en **`ERPlora/modules-workspace/`** (creado con `startproject`, cada
módulo su propio repo git en `modules/<id>/`).

⚠️ **`ls modules-workspace/modules/` ya NO los cuenta**: la flota crea ahí dentro sus worktrees
(`appointments-wt-159`, `customers-wt-70`…), y un worktree tiene `.git` como **fichero**, no como
directorio. El recuento vivo es:

```sh
ls -d modules-workspace/modules/*/ | while read d; do [ -d "$d.git" ] && echo "$d"; done | wc -l
```

Para trabajar:

```sh
cd modules-workspace
npm install                 # toolkit + Ionic + OutfitKit + SDK + lit (registry público vía .npmrc)
npx erplora dev inventory   # preview en http://localhost:4321 (CSP-safe, watch)
npx erplora build inventory # → modules/inventory/dist/inventory.esm.js
npx erplora pack inventory  # module.zip + sha256 en modules/inventory/build/
```

El Hub consume los `dist/` de aquí: `hub/apps/web/sync-modules.mjs` **resuelve**
`modules-workspace/modules` subiendo desde su propia ruta —y antes mira `ERPLORA_MODULES_DIR` y
`HUB_MODULES_DIR`—, así que también funciona desde un worktree (ERPlora/hub#787); `pnpm -F
@erplora/web verify` queda VERDE.

## Pendiente / deuda conocida

- **`publish`**: deliberadamente NO automatizado (acción autenticada contra Cloud + S3 inmutable).
  Imprime el flujo; subir+registrar requiere confirmación y credenciales.
- **`erplora test --against-hub` no está en el gate compartido**
  ([module-toolkit#112](https://github.com/ERPlora/module-toolkit/issues/112)) y hoy no sabe
  instalar un módulo con `depends_on`
  ([module-toolkit#135](https://github.com/ERPlora/module-toolkit/issues/135)). Las dos abiertas;
  mientras tanto quien corre esas baterías es la CI del hub (§ *La batería contra el kernel REAL*).
- **Distribución a devs externos**: `@erplora/outfitkit` **ya está publicado en npm** (MIT); en el
  workspace local se enlaza por `file:../outfitkit`. `@erplora/module-sdk` y
  `@erplora/module-types` siguen enlazados por `file:../hub/packages/*` y **sin publicar** (uso
  interno): para terceros del marketplace queda **publicar/vendorizar** esos dos. Fase aparte —
  [`DECISION-aislamiento-terceros.md`](DECISION-aislamiento-terceros.md).

> 🪦 Dos entradas que vivieron aquí y ya no son deuda: la **firma criptográfica** (`erplora sign`
> firma ed25519 desde ADR-0193; el anillo del hub es `HUB_MODULE_TRUSTED_KEYS`) y
> **`hub/packages/module-cli`**, que dejó de estar «deprecado pendiente de borrar» — se **borró**
> del hub, con una guardia que caza el paquete muerto (ERPlora/hub#1244/#1248).
