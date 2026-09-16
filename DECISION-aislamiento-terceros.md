# Aislamiento de terceros — el toolkit NO debe exponer el core del Hub

> **Estado: DECISIÓN parcial tomada (2026-06-28) + arquitectura objetivo documentada para "cuando
> lleguemos allí".** No implementar todavía: el gate es la **apertura del marketplace a terceros**,
> que es una decisión de producto de Ioan y no está en el camino del MVP. Cuando se ejecute, el
> diseño del core / API pública del SDK se decide como cualquier otro trabajo técnico —código
> existente + TDD, documentándolo en vez de pidiéndolo (ERPlora/pm#43)— y el ADR va a
> `architecture/` + decision-log.

> ⚠️ **Enmendado por ADR-0431 y ADR-0432 (02–03/09/2026) en un punto que este documento daba por
> supuesto: qué SIGNIFICA «sellada».** Al disolver `NativeHost::fiscal_gateway_access` en primitivos
> genéricos (ERPlora/hub#1459/#1464, de donde salen esos dos ADR), quedó escrito que **el host es un
> DECORADOR, no un cortafuegos**: `http.fetch` **no acota destinos** —la URL la elige el módulo y
> `capabilities.network.allow` es documentación del manifest para la pantalla de consentimiento, no
> un control del runtime— y lo que sí se acota es **a quién se le prestan NUESTRAS credenciales**,
> que solo viajan a hosts de ERPlora. La identidad de máquina no es un primitivo aparte sino un
> segundo valor cerrado del campo que ya existía: `http.fetch(req, identity: "machine")`.
>
> Para este documento eso no deroga la decisión —Tier 2 sigue siendo WASM contra una SDK sellada—,
> la **acota**: el sello es sobre **el código que un tercero puede VER y del que puede depender**
> (el runtime y los crates de negocio del Hub), NO un sandbox de red. Un módulo de un tercero con la
> capability `network` concedida llama a donde quiera. Lo que el diseño de abajo sigue teniendo que
> resolver es lo suyo: publicar el contrato, no clonar el Hub.

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

## Estado actual REAL (casi todo sigue yendo por rutas al repo del Hub) ⚠️

| Pieza | Cómo está hoy | Problema |
|-------|---------------|----------|
| `guest-sdk` (Rust, Tier 2) | Módulos lo referencian por **path de fichero**: los **22** que lo declaran apuntan a `path="../../../../hub/crates/guest-sdk"` (ninguno usa ya la copia stale) | Obliga a tener el **repo del Hub** al lado; no es un paquete sellado |
| `@erplora/module-sdk` (JS) | `version 1.0.0`, MIT, **sin publicar en npm** (el registry no lo conoce); el toolkit lo usa con `file:../hub/packages/module-sdk` | Path al repo del Hub |
| `@erplora/module-types` | `private: true`, `version 0.0.0`; `file:../hub/packages/module-types` | Path al repo del Hub |
| `@erplora/outfitkit` | **Ya publicado en npm** (MIT); en el workspace local se enlaza por `file:../outfitkit` para poder iterar | ✅ resuelto para un tercero: `npm i @erplora/outfitkit` |
| `module-toolkit` (CLI) | No publicado como paquete instalable global | Un tercero no puede `npm i -g` sin los repos |
| `dev` / `build` / runtime | `dev` mockea `globalThis.erplora`; `build` solo compila el WC; runtime nunca se distribuye | ✅ Esto ya está bien (sellado/mockeado) |

**Resumen:** el runtime ya está sellado (bien ✅), pero **las SDK y el toolkit se sirven por rutas de
fichero al repo del Hub** → hoy un tercero no podría trabajar sin clonar el Hub. Ese es el hueco.

## Estado OBJETIVO (cómo debería quedar)

Para cumplir la decisión (Tier 2 vía SDK sellada, sin repo Hub):

1. **`guest-sdk` (Rust) publicado como crate sellado** (CodeArtifact privado o crates.io) — solo el
   contrato (`Input/Operation/Output/Event`). Los módulos lo declaran por **versión**, no por path al
   Hub. (Cierra **TW1**: borrar la copia stale `modules-workspace/crates/guest-sdk`, que
   sigue ahí y sigue sin el campo `result`. El crate **canónico** del Hub ya no es el problema: el
   `result` de ADR-0069 está en `hub/crates/guest-sdk` desde ERPlora/hub#70.)
2. **`@erplora/module-sdk` y `module-types` publicados como paquetes npm versionados** (no
   `file:`), como ya lo está `outfitkit`. El toolkit y los módulos dependen de versiones publicadas.
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

- [ ] Publicar `erplora-guest-sdk` (Rust) sellado y borrar la copia stale `modules-workspace/crates/guest-sdk` (TW1). El contrato ya está alineado: `Output.result` (ADR-0069) vive en el crate del Hub.
- [ ] Despublicar el `file:`/path: publicar `module-sdk`/`module-types`/`module-toolkit` versionados (`outfitkit` ya está en npm).
- [ ] Único punto de verdad del schema del manifest + `BRIDGE_FUNCTIONS` (TW8/TW9).
- [ ] Decidir prueba local: `dev` mock vs binario `erplora-dev` sellado.
- [ ] ADR formal en `architecture/` + decision-log.
