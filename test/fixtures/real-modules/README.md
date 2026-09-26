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
