# Aislamiento de terceros — el toolkit NO debe exponer el core del Hub

> **Estado: DECISIÓN parcial tomada (2026-06-28) + arquitectura objetivo documentada para "cuando
> lleguemos allí".** No implementar todavía: el gate es la **apertura del marketplace a terceros**,
> que es una decisión de producto de Ioan y no está en el camino del MVP. Cuando se ejecute, el
> diseño del core / API pública del SDK se decide como cualquier otro trabajo técnico —código
> existente + TDD, documentándolo en vez de pidiéndolo (ERPlora/pm#43)— y el ADR va a
> `architecture/` + decision-log.

## Requisito de negocio

El Hub (runtime Rust + funcionalidades) es **el negocio principal de ERPlora**. El workspace de
módulos (`modules-workspace/` + `module-toolkit`) debe permitir a un desarrollador externo **crear y
probar SU módulo de forma eficiente**, pero **NO** ver/usar el código Rust del Hub ni reconstruir un
Hub propio con las mismas funcionalidades. El tercero solo debería tocar **Web Components** + el
**contrato declarativo** (`module.json`, queries/commands SQL, migraciones) y, para lógica avanzada,
una **SDK sellada** (sin ver el resto del Hub).

## ✅ Decisión tomada (2026-06-28)

- **Alcance de terceros:** pueden hacer **Tier 2 (WASM)**, pero a través de una **SDK sellada** —
  se les expone el *contrato* del SDK, nunca el runtime ni los crates de negocio del Hub. (Opción B.)
- **Entorno de prueba:** se les **expone una SDK/herramienta** para probar; el detalle exacto
  (toolkit con `dev` mock vs binario `erplora-dev` sellado) se concreta al ejecutar — ver "objetivo".

## Estado actual REAL (hoy todo va por rutas al repo del Hub) ⚠️

| Pieza | Cómo está hoy | Problema |
|-------|---------------|----------|
| `guest-sdk` (Rust, Tier 2) | Módulos lo referencian por **path de fichero**: los 23 que lo declaran apuntan hoy a `path="../../../../hub/crates/guest-sdk"` (ninguno usa ya la copia stale) | Obliga a tener el **repo del Hub** al lado; no es un paquete sellado |
| `@erplora/module-sdk` (JS) | `private: true`, `version 0.0.0`, **sin publicar**; toolkit lo usa con `file:../hub/packages/module-sdk` | Path al repo del Hub |
| `@erplora/module-types`, `@erplora/outfitkit` | También `file:../hub/packages/...` / `file:../outfitkit` | Path a repos hermanos |
| `module-toolkit` (CLI) | No publicado como paquete instalable global | Un tercero no puede `npm i -g` sin los repos |
| `dev` / `build` / runtime | `dev` mockea `globalThis.erplora`; `build` solo compila el WC; runtime nunca se distribuye | ✅ Esto ya está bien (sellado/mockeado) |

**Resumen:** el runtime ya está sellado (bien ✅), pero **las SDK y el toolkit se sirven por rutas de
fichero al repo del Hub** → hoy un tercero no podría trabajar sin clonar el Hub. Ese es el hueco.

## Estado OBJETIVO (cómo debería quedar)

Para cumplir la decisión (Tier 2 vía SDK sellada, sin repo Hub):

1. **`guest-sdk` (Rust) publicado como crate sellado** (CodeArtifact privado o crates.io) — solo el
   contrato (`Input/Operation/Output/Event`). Los módulos lo declaran por **versión**, no por path al
   Hub. (Cierra **TW1**: borrar la copia stale `modules-workspace/crates/guest-sdk` y, antes de
   publicar, alinear el contrato — le falta el campo `result` de ADR-0069.)
2. **`@erplora/module-sdk` / `module-types` / `outfitkit` publicados como paquetes npm versionados**
   (no `file:`). El toolkit y los módulos dependen de versiones publicadas.
3. **`@erplora/module-toolkit` publicado** como CLI instalable (`npm i -g @erplora/module-toolkit`),
   sin necesidad de ningún repo del Hub.
4. **Único punto de verdad del manifest** (cierra **TW8/TW9**): el schema y `BRIDGE_FUNCTIONS` que hoy
   el toolkit duplica a mano deben venir de la fuente publicada, no re-copiados.
5. **Prueba local del tercero** = el toolkit (`dev`) contra la SDK sellada. Si se quiere prueba fiel
   (no mock), valorar un **binario `erplora-dev` sellado** distribuido por release. (Detalle a fijar.)

Resultado: un tercero hace `npm i -g @erplora/module-toolkit`, `erplora startproject`, desarrolla su
WC + (opcional) su handler WASM contra el crate `erplora-guest-sdk` **publicado**, y prueba con el
toolkit — **sin tocar ni ver el repo del Hub**.

## Pendiente de ejecución (cuando lleguemos allí)

- [ ] Publicar `erplora-guest-sdk` (Rust) sellado + alinear contrato (campo `result`, ADR-0069) y borrar copia stale (TW1).
- [ ] Despublicar el `file:`/path: publicar `module-sdk`/`module-types`/`outfitkit`/`module-toolkit` versionados.
- [ ] Único punto de verdad del schema del manifest + `BRIDGE_FUNCTIONS` (TW8/TW9).
- [ ] Decidir prueba local: `dev` mock vs binario `erplora-dev` sellado.
- [ ] ADR formal en `architecture/` + decision-log.
