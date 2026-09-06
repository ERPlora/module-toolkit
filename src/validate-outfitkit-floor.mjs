// El SUELO de core que un módulo necesita, comprobado en la puerta del autor — module-toolkit#201.
//
// **Qué problema resuelve.** Los `ok-*` con los que se pinta un módulo son los del SHELL, no los
// que lleva su bundle: el shell los define al arrancar y el `define()` horneado pierde en silencio
// (`src/outfitkit-stamp.mjs`, ADR-0133 §verificación 2). O sea que quien decide cómo se ve la
// pantalla es el OutfitKit de la IMAGEN del hub — y esa imagen instala `@erplora/outfitkit@latest`
// en cada build (`hub/docker/Dockerfile`, con cachebust), así que el checkout del autor va casi
// siempre POR DELANTE de lo que hay desplegado.
//
// Costó dos veces en cuatro días: reservas 3.0.26 (hub#1547) pidió una capacidad de la tabla que el
// hub de la flota no tiene, y ventas 2.16.x (sales#259) anunció el botón de devolver de cada fila
// con un trozo de código fuente en vez de con la palabra «Devolver» en TODOS los hubs desplegados
// — `DataTableAction.label` solo acepta una función desde OutfitKit 0.1.59, y el tag de la flota
// `v1.1.13` lleva 0.1.58. Quien lo sufre es el cliente, días después, y no puede arreglarlo.
//
// **La mitad que decide ya existía.** El manifest tiene `compatibility.min_erplora_version` y el
// hub la APLICA desde hub#521: si el módulo pide un core más nuevo, rechaza la instalación con un
// mensaje accionable en vez de instalar algo a medias. Lo que faltaba es que alguien la reclamara
// antes de publicar, que es este fichero.
//
// 🔴 **NO es un big bang, y ese es el diseño.** El sello dice contra qué OutfitKit se horneó, no qué
// APIs se usan: exigir un suelo a todo el que hornee con algo nuevo pondría los 27 módulos en rojo
// el mismo día por algo que no han hecho, y un gate que bloquea a todo el mundo se apaga, no se
// obedece (misma lección que `FILL_GRANDFATHERED` en `validate-ionic-fill.mjs`). Así que solo hay
// dos rojos, y los dos son afirmaciones DEMOSTRABLEMENTE falsas:
//
//   1. El módulo declara un suelo y horneó contra un OutfitKit que ese suelo NO lleva. Dice que
//      corre en un hub que no puede pintarlo.
//   2. El módulo no declara nada — que significa «cualquier hub» — y horneó contra un OutfitKit que
//      NINGÚN hub conocido lleva. «Cualquiera» es falso para todos, no solo para los viejos.
//
// Medido el 2026-09-06 sobre los `dist/outfitkit.json` commiteados del workspace: los sellos van de
// 0.1.44 a 0.1.59 y el hub más nuevo lleva 0.1.58 → 25 de 27 módulos siguen en verde y los dos que
// no (`sales` e `inventory`, ambos 0.1.59) son exactamente la clase de fallo que esto persigue.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTFITKIT_STAMP } from './outfitkit-stamp.mjs';

/**
 * Qué versión de OutfitKit lleva cada imagen del hub, por tag.
 *
 * 🔴 **DERIVADA POR FECHA, y hay que decirlo.** Hoy no existe en ningún sitio: `docker/Dockerfile`
 * hace `pnpm --filter @erplora/web add @erplora/outfitkit@latest` con un cachebust por build, así
 * que la versión de una imagen solo se deduce de CUÁNDO se construyó. Cada fila es «el último
 * `@erplora/outfitkit` publicado en npm antes de que se creara el tag», y `built_at` es la fecha de
 * creación del tag en `ERPlora/hub`. El margen más ajustado de la tabla es el de `1.1.4` (12
 * minutos); el resto van de horas a días.
 *
 * La fila de `1.1.13` es la que sales#265 midió a mano por otro camino y coincide: es el control de
 * que la derivación reproduce el positivo conocido, y `test/validate-outfitkit-floor.test.mjs` la
 * clava para que deje de cuadrar en voz alta el día que la derivación se tuerza.
 *
 * ⚠️ Esta tabla es un APAÑO honesto, no la fuente de verdad: quien SABE la versión es el build del
 * hub, que hoy no la publica en ningún artefacto. Que la emita él (y esto la lea) es la otra mitad,
 * y vive en hub#1588. Mientras tanto, añadir un tag aquí es parte de publicar el hub.
 *
 * Solo la línea `1.1.x`: `1.0.x` y anteriores son pre-flota, y `1.0.2` se etiquetó 11 segundos
 * después de publicarse 0.1.36 — un margen que no aguanta ninguna afirmación.
 */
export const HUB_OUTFITKIT = [
  { hub: '1.1.0', built_at: '2026-08-12T08:20:02Z', outfitkit: '0.1.36' },
  { hub: '1.1.1', built_at: '2026-08-13T00:13:20Z', outfitkit: '0.1.36' },
  { hub: '1.1.2', built_at: '2026-08-14T00:18:45Z', outfitkit: '0.1.36' },
  { hub: '1.1.3', built_at: '2026-08-14T04:54:31Z', outfitkit: '0.1.36' },
  { hub: '1.1.4', built_at: '2026-08-16T08:59:55Z', outfitkit: '0.1.40' },
  { hub: '1.1.5', built_at: '2026-08-16T13:26:13Z', outfitkit: '0.1.40' },
  { hub: '1.1.6', built_at: '2026-08-16T22:05:46Z', outfitkit: '0.1.40' },
  { hub: '1.1.7', built_at: '2026-08-16T23:20:26Z', outfitkit: '0.1.40' },
  // 🪤 `1.1.9` se etiquetó 77 segundos ANTES que `1.1.8`. No es un error de la tabla: es lo que dice
  // `git for-each-ref` del repo del hub. Por eso aquí no se afirma que `built_at` crezca con el tag.
  { hub: '1.1.8', built_at: '2026-08-19T16:52:11Z', outfitkit: '0.1.40' },
  { hub: '1.1.9', built_at: '2026-08-19T16:50:54Z', outfitkit: '0.1.40' },
  { hub: '1.1.10', built_at: '2026-08-26T21:30:45Z', outfitkit: '0.1.56' },
  { hub: '1.1.11', built_at: '2026-08-29T02:21:32Z', outfitkit: '0.1.56' },
  { hub: '1.1.12', built_at: '2026-09-02T07:00:29Z', outfitkit: '0.1.58' },
  { hub: '1.1.13', built_at: '2026-09-02T18:09:28Z', outfitkit: '0.1.58' },
];

/**
 * Compara dos versiones `x.y.z` por NÚMERO. Devuelve <0, 0 o >0.
 *
 * 🔴 Comparar estas versiones como cadenas deja pasar justo lo que esto persigue: `'0.1.9' > '0.1.58'`
 * es verdad para el orden alfabético y mentira para el producto. La cola de prerelease/build se
 * ignora a propósito: `0.1.59-rc.1` y `0.1.59` llevan el mismo contrato de componentes.
 */
export function compareOutfitkitVersions(a, b) {
  const parts = (v) =>
    String(v ?? '')
      .split(/[-+]/, 1)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** El hub más nuevo que la tabla conoce. Es el techo de lo que hay desplegado. */
export function newestKnownHub() {
  return HUB_OUTFITKIT[HUB_OUTFITKIT.length - 1];
}

/**
 * Qué hub resuelve un suelo declarado `min_erplora_version`, y con qué OutfitKit.
 *
 * 🔴 Resuelve HACIA ABAJO: el suelo es una promesa sobre el hub MÁS DÉBIL que el módulo acepta, así
 * que la fila que manda es la del tag más antiguo que aún satisface el suelo. Resolverlo al más
 * nuevo haría que toda declaración se cumpliera sola y el control no saltaría jamás.
 *
 * - Suelo más viejo que toda la tabla → la fila más antigua que conocemos (y el mensaje lo dice).
 * - Suelo más nuevo que toda la tabla → `null`: no lo sabemos, y no se inventa.
 */
export function outfitkitForFloor(minHubVersion) {
  const satisfying = HUB_OUTFITKIT.filter(
    (row) => compareOutfitkitVersions(row.hub, minHubVersion) >= 0,
  );
  if (!satisfying.length) return null;
  return satisfying[0];
}

/**
 * El siguiente tag de hub después de `hub` — el primero que PODRÍA llevar un OutfitKit más nuevo.
 *
 * Existe para que el mensaje de error tenga siempre una salida de una línea. Sin él, a quien hornea
 * contra un OutfitKit que aún no lleva ningún hub solo le queda «espera», y un gate sin acción
 * posible es un gate que se apaga.
 */
export function nextHubAfter(hub) {
  const parts = String(hub).split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.join('.');
}

/** El hub más antiguo que lleva `outfitkitVersion` o algo más nuevo. `null` si ninguno llega. */
export function oldestHubShipping(outfitkitVersion) {
  return (
    HUB_OUTFITKIT.find(
      (row) => compareOutfitkitVersions(row.outfitkit, outfitkitVersion) >= 0,
    ) ?? null
  );
}

/** Lee `dist/outfitkit.json`. `undefined` = no hay sello; `null` = lo hay y no se puede leer. */
function readStamp(dir) {
  const file = join(dir, 'dist', OUTFITKIT_STAMP);
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))?.outfitkit;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/**
 * La puerta: ¿existe algún hub capaz de pintar lo que este módulo horneó, y lo dice el manifest?
 *
 * Devuelve `{ errors, warnings }`. Sin sello no dice nada: es el estado de los módulos construidos
 * antes de que el sello existiera, y el shell ya sabe tratar su ausencia.
 */
export function checkOutfitkitFloor(dir, manifest) {
  const errors = [];
  const warnings = [];

  const stamp = readStamp(dir);
  if (stamp === undefined) return { errors, warnings };
  if (stamp === null) {
    warnings.push(
      `dist/${OUTFITKIT_STAMP} existe pero no se puede leer (JSON roto o sin la clave ` +
        '`outfitkit`). Sin sello no se puede comprobar contra qué hub corre este módulo: ' +
        'reconstruye con `erplora build`.',
    );
    return { errors, warnings };
  }

  const declared = manifest?.compatibility?.min_erplora_version;
  const needed = oldestHubShipping(stamp);
  const howToDeclare = needed
    ? `Declara \`"compatibility": { "min_erplora_version": "${needed.hub}" }\` en el manifest ` +
      `(el hub más antiguo que lleva OutfitKit ${stamp}) — el hub lo aplica al instalar (hub#521) ` +
      'y quien tenga un core más viejo recibe un mensaje accionable en vez de una pantalla rota.'
    : `NINGÚN hub publicado lleva OutfitKit ${stamp} todavía (el más nuevo, ` +
      `${newestKnownHub().hub}, lleva ${newestKnownHub().outfitkit}). Tienes dos salidas y las dos ` +
      `valen: reconstruir contra ${newestKnownHub().outfitkit}, o declarar ` +
      `\`"compatibility": { "min_erplora_version": "${nextHubAfter(newestKnownHub().hub)}" }\` — el ` +
      'primer core que podrá llevarlo. Declararlo NO es hacer trampa: es la afirmación cierta («esto ' +
      'necesita un hub más nuevo que ninguno publicado»), y el hub rechaza la instalación en los ' +
      'viejos con un mensaje accionable (hub#521) en vez de pintar la pantalla mal.';

  if (declared) {
    const floor = outfitkitForFloor(declared);
    if (!floor) {
      warnings.push(
        `compatibility.min_erplora_version = ${declared} es más nuevo que cualquier hub que esta ` +
          `tabla conoce (el último es ${newestKnownHub().hub}), así que no se puede comprobar el ` +
          `sello ${stamp} contra él. Se deja pasar a propósito: declarar un core que aún no ha ` +
          'salido es la forma CORRECTA de publicar un módulo que lo necesita, y el hub rechaza la ' +
          'instalación en los viejos (hub#521). Añade el tag a `HUB_OUTFITKIT` cuando se publique.',
      );
      return { errors, warnings };
    }
    if (compareOutfitkitVersions(stamp, floor.outfitkit) > 0) {
      const older = compareOutfitkitVersions(floor.hub, declared) > 0 ? ` (el más antiguo ≥ ${declared})` : '';
      errors.push(
        `el módulo se horneó contra OutfitKit ${stamp}, pero dice correr desde el core ` +
          `${declared}${older}: el hub ${floor.hub} lleva OutfitKit ${floor.outfitkit}, y los ` +
          '`ok-*` que pintan son los del SHELL, no los del bundle (ADR-0133). Ahí la pantalla sale ' +
          `distinta de como la probaste, sin que nada falle. ${howToDeclare}`,
      );
    }
    return { errors, warnings };
  }

  const newest = newestKnownHub();
  if (compareOutfitkitVersions(stamp, newest.outfitkit) > 0) {
    errors.push(
      `el módulo se horneó contra OutfitKit ${stamp} y no declara ` +
        '`compatibility.min_erplora_version`, o sea que dice correr en CUALQUIER hub — pero el más ' +
        `nuevo que existe (${newest.hub}) lleva OutfitKit ${newest.outfitkit}, así que no hay uno ` +
        'solo que pueda pintarlo. Los `ok-*` que pintan son los del SHELL, no los del bundle ' +
        `(ADR-0133): la pantalla sale rota en casa del cliente y él no puede arreglarlo. ${howToDeclare}`,
    );
  }
  return { errors, warnings };
}
