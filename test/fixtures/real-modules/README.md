# Módulos reales congelados (module-toolkit#352)

Copias **byte a byte** de lo mínimo que necesitan las pruebas del toolkit contra módulos reales.
Antes se leían de `../../modules-workspace/modules/<id>`, que ningún runner de la CI tiene, y se
saltaban en silencio (`skipped 3` detrás de un check verde).

| Fichero | Origen | Lo usa |
|---|---|---|
| `tables/module.json`, `tables/dist/handler.wasm` | `ERPlora/tables@21a7fbc` | `test/wasm.test.mjs` (tables#25) |
| `inventory/ui/components/erp-inventory-products/erp-inventory-products.ts` | `ERPlora/inventory@d4e4263` | `test/icons.test.mjs` (inventory#32) |

No se refrescan: reproducen el caso que cazó cada regresión. Que el módulo de HOY siga cumpliendo
lo comprueba el gate de su propio repo (`erplora validate` corre el mismo control de exports; `erplora
build` hornea los iconos).

**Una copia no puede divergir en silencio de su origen**: `provenance.json` fija el commit y el
`sha256` de cada fichero y `test/real-module-fixtures.test.mjs` los comprueba en la CI. Para cambiar
una fixture se vuelve a copiar del repo del módulo y se actualiza `provenance.json` con el commit
nuevo (`shasum -a 256 <fichero>`); un byte editado a mano pone la CI en rojo.
