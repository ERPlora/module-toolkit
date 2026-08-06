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
| `erplora build <id\|dir>` | ✅ | Compila el WC (Lit) a `dist/<id>.esm.js` (auto-contenido, CSP-safe). |
| `erplora validate <id\|dir>` | ✅ | Valida el manifest (contrato `architecture/hub/module-system.md`) + CSP del bundle + handlers WASM (si `handler.type === "wasm"`, rechaza un `dist/handler.wasm` desincronizado del fuente — guardarraíl module-toolkit#135). |
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
