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
// 🔴 **TRINQUETE, no big bang — y el reparto es lo que lo hace desplegable.** Hay dos casos, y NO
// pesan lo mismo:
//
//   1. El módulo **declara** un suelo y horneó contra un OutfitKit que ese suelo NO lleva. Es una
//      afirmación del autor demostrablemente falsa: dice correr en un hub que no puede pintarlo.
//      → **ERROR siempre**, también en `validate`.
//   2. El módulo **no declara nada** —que significa «cualquier hub»— y horneó contra un OutfitKit
//      que NINGÚN hub conocido lleva. → **AVISO en `validate`, ERROR en `pack`** (`publishing`).
//
// Por qué el (2) no puede ser rojo en `validate`, medido el 2026-09-06 en este árbol: el sello NO
// lo elige el autor. `stampOutfitkit()` lo resuelve desde `node_modules/@erplora/outfitkit`, que en
// este repo es **`file:../outfitkit`** — el checkout de desarrollo compartido, hoy en 0.1.59 con
// npm ya en 0.1.65, o sea por delante de la flota (0.1.58) **por la propia premisa de la issue**. Y
// `validate` obliga a reconstruir en cuanto se toca `ui/**` (`checkBundleArtifact`). Sumado: la
// siguiente PR de CUALQUIERA de los 27 módulos que toque su UI se pondría roja por la cadencia de
// release del hub, no por nada que hiciera su autor. Un gate que para a todo el mundo se apaga, no
// se obedece — es la misma lección de `FILL_GRANDFATHERED` y el MISMO reparto que hace
// `bundle-freshness.mjs` al lado (con sello → error; sin sello → aviso).
//
// Y donde sí bloquea es en `erplora pack`, que es la puerta del marketplace: construye y prueba
// contra lo que quieras, pero no PUBLICAS una pantalla que ningún hub sabe pintar. Es el modelo de
// cualquier tienda de aplicaciones — compilas contra el SDK nuevo, la tienda comprueba al enviar.
//
// 🔵 **module-toolkit#203 — la fuente real ya existe, y cuando contesta MANDA.** El día que se
// escribió lo de arriba, «qué OutfitKit lleva el hub 1.1.13» solo se podía DEDUCIR. Desde
// ERPlora/hub#1588 el hub lo dice él: `GET /outfitkit-version.json` → `{ outfitkit, hub }`. Cuando
// `readHubOutfitkit()` (`src/hub-outfitkit-source.mjs`) trae esa lectura, su fila SUSTITUYE a la
// derivada y la comparación pasa de conjetura a hecho. Eso cambia el resultado en las dos
// direcciones, y las dos importan:
//
//   - **Cierra el agujero.** Un suelo declarado que la tabla no conocía se dejaba pasar con un
//     aviso («añade el tag cuando se publique») y el módulo se PUBLICABA prometiendo un hub en el
//     que no cabe. Con la lectura real ese caso se comprueba y se RECHAZA.
//   - **Quita la falsa alarma.** La derivación va por detrás de la realidad —la imagen instala
//     `@erplora/outfitkit@latest` en cada build y la tabla anota lo último publicado ANTES del
//     tag—, así que llamaba «más nuevo que todo hub» a horneados perfectamente pintables.
//
// Lo que NO cambia: sin lectura real —nadie configuró `ERPLORA_HUB_URL`, no hay red, o el hub es
// anterior a #1588 y su capa estática devuelve `index.html` con 200— se usa la tabla derivada y
// todo se comporta EXACTAMENTE como antes. Degradar siempre se puede; bloquear por una degradación,
// nunca. Y el trinquete de #201 sigue en pie: con número real, `validate` sigue avisando y quien
// bloquea sigue siendo `pack`, porque el sello lo pone `../outfitkit`, no el autor.
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
 * ⚠️ Esta tabla ya NO es la respuesta por defecto: es el CAMINO DEGRADADO (module-toolkit#203).
 * Quien SABE la versión es el hub, y desde ERPlora/hub#1588 la publica en
 * `/outfitkit-version.json`; `hubOutfitkitTable(source)` mete esa lectura aquí y la fila real gana.
 * La tabla es lo que queda cuando no hay hub que preguntar —sin `ERPLORA_HUB_URL`, sin red, o un
 * hub anterior a #1588—, y mientras haya hubs vivos sin el sello, añadir un tag aquí sigue siendo
 * parte de publicar el hub.
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
  // v1.1.14 («Develop → main — lote v1.1.14», 2026-09-06): el último @erplora/outfitkit publicado en
  // npm antes de crearse el tag es 0.1.65 (2026-09-05T07:55Z); 0.1.66 no existía aún.
  { hub: '1.1.14', built_at: '2026-09-06T13:50:24Z', outfitkit: '0.1.65' },
  // v1.1.15 («Develop → main — promoción 06/09 (2.ª)», tagged 2026-09-06T16:11:26Z): the newest
  // @erplora/outfitkit on npm before the tag is still 0.1.65 (2026-09-05T07:55Z); nothing newer
  // had been published by then.
  { hub: '1.1.15', built_at: '2026-09-06T16:11:26Z', outfitkit: '0.1.65' },
  // v1.1.16 («Develop — lote v1.1.16», tagged 2026-09-07T14:14:49Z): the newest
  // @erplora/outfitkit on npm before the tag is STILL 0.1.65 (2026-09-05T07:55Z) — it is the
  // latest version published at all, so three hub releases in a row derive the same floor.
  { hub: '1.1.16', built_at: '2026-09-07T14:14:49Z', outfitkit: '0.1.65' },
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

/**
 * Lo que sabemos de la flota: la tabla derivada con la LECTURA REAL encima (module-toolkit#203).
 *
 * `source` es la fila que devuelve `readHubOutfitkit()` — `{ hub, outfitkit }` leída del propio hub.
 * Si la trae, sustituye a la fila derivada de ese mismo tag (un hecho no convive con su conjetura)
 * o se añade si el tag no estaba. Sin `source`, o con media fila, devuelve la tabla tal cual: ese
 * es el camino degradado, y tiene que ser idéntico al de antes.
 *
 * 🔴 Devuelve SIEMPRE un array nuevo y ordenado por tag. `HUB_OUTFITKIT` es una constante de módulo
 * compartida por todas las llamadas del proceso: mutarla haría que el resultado de un módulo
 * dependiera de si otro se validó antes. Y el orden no es estética — `outfitkitForFloor` devuelve
 * la PRIMERA fila que satisface y `oldestHubShipping` la primera que llega, así que ambas contestan
 * «la más antigua» solo mientras la tabla esté ordenada.
 */
export function hubOutfitkitTable(source = null) {
  if (!source?.hub || !source?.outfitkit) return HUB_OUTFITKIT;
  const rows = HUB_OUTFITKIT.filter((row) => compareOutfitkitVersions(row.hub, source.hub) !== 0);
  rows.push({ hub: source.hub, outfitkit: source.outfitkit, measured: true });
  rows.sort((a, b) => compareOutfitkitVersions(a.hub, b.hub));
  return rows;
}

/** El hub más nuevo que la tabla conoce. Es el techo de lo que hay desplegado. */
export function newestKnownHub(table = HUB_OUTFITKIT) {
  return table[table.length - 1];
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
export function outfitkitForFloor(minHubVersion, table = HUB_OUTFITKIT) {
  const satisfying = table.filter(
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
export function oldestHubShipping(outfitkitVersion, table = HUB_OUTFITKIT) {
  return (
    table.find(
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
 *
 * `publishing` = se está empaquetando para el marketplace (`erplora pack`). Es lo único que separa
 * el aviso del bloqueo en el caso «sin suelo declarado»: ver el trinquete de la cabecera.
 */
export function checkOutfitkitFloor(dir, manifest, { publishing = false, source = null } = {}) {
  const errors = [];
  const warnings = [];
  // module-toolkit#203: con lectura real del hub, la fila real manda; sin ella, la tabla derivada.
  const table = hubOutfitkitTable(source);
  const measured = table.some((row) => row.measured);

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
  const needed = oldestHubShipping(stamp, table);
  const newestHub = newestKnownHub(table);
  // De dónde sale CADA número que se cita. Un mensaje que no lo dice deja al autor sin saber si
  // discute con un hecho o con una deducción — y son dos conversaciones distintas.
  //
  // 🔴 Se pregunta por FILA, no por «hay lectura real en la tabla»: `ERPLORA_HUB_URL` puede apuntar
  // a un cliente en un core viejo, y entonces el techo de la flota que enseñan estos mensajes sigue
  // siendo el derivado por fecha. Firmarlo como medido en un hub que no lleva ese número convierte
  // el sello de hub#1588 en una etiqueta decorativa. Y una lectura de CACHE se presenta como lo que
  // es —un recuerdo—, porque sin `ERPLORA_HUB_URL` se usa sin avisar y puede subir a ERROR en
  // `pack`: bloquear en silencio con un dato viejo es la otra mitad de ablandarse en silencio.
  const provenanceOf = (row) =>
    row?.measured
      ? source.origin === 'cache'
        ? `leído del hub ${source.hub} en una consulta ANTERIOR y recordado en cache, así que ` +
          'puede haberse quedado atrás'
        : `medido en el hub ${source.hub}, que publica su propio sello (ERPlora/hub#1588)`
      : 'deducido por la fecha del tag (`HUB_OUTFITKIT`), no medido';
  // 🔴 Las dos salidas se dan CON SU PRECIO. Una salida cuyo coste se calla no es una elección, es
  // una trampa: declarar el tag siguiente deja el módulo sin instalarse en NINGÚN hub vivo hasta
  // que ese tag salga (hub#521 lo aplica), y reconstruir más abajo obliga a mover `../outfitkit`,
  // que es un checkout compartido y no es del autor. Quien decide con el coste delante elige bien.
  const howToDeclare = needed
    ? `Declara \`"compatibility": { "min_erplora_version": "${needed.hub}" }\` en el manifest ` +
      `(el hub más antiguo que lleva OutfitKit ${stamp}) — el hub lo aplica al instalar (hub#521) ` +
      'y quien tenga un core más viejo recibe un mensaje accionable en vez de una pantalla rota. ' +
      `COSTE: en los hubs anteriores a ${needed.hub} el módulo dejará de instalarse hasta que ` +
      'actualicen.'
    : `NINGÚN hub publicado lleva OutfitKit ${stamp} todavía (el más nuevo, ${newestHub.hub}, ` +
      `lleva ${newestHub.outfitkit} — ${provenanceOf(newestHub)}). Dos salidas, con su precio: (a) declarar ` +
      `\`"compatibility": { "min_erplora_version": "${nextHubAfter(newestHub.hub)}" }\`, que es la ` +
      'afirmación CIERTA («necesita un hub más nuevo que ninguno publicado») y hace que el hub ' +
      'rechace la instalación con un mensaje accionable (hub#521) en vez de pintar la pantalla mal ' +
      `— COSTE: el módulo dejará de instalarse en TODA la flota viva (${newestHub.hub} y ` +
      'anteriores) hasta que salga ese tag; (b) reconstruir contra ' +
      `${newestHub.outfitkit} — COSTE: hay que bajar el checkout compartido \`../outfitkit\`, que ` +
      'no es tuyo, así que afecta a quien esté trabajando en él.';

  if (declared) {
    const floor = outfitkitForFloor(declared, table);
    if (!floor) {
      // 🔴 module-toolkit#203: este aviso es el agujero por el que se publicaba una promesa falsa
      // —el suelo se declaraba sobre un hub que la tabla derivada no conocía y nadie lo comprobaba.
      // Con la lectura real deja de ocurrir por sí solo: si el hub que se declara es el que
      // contestó, `outfitkitForFloor` lo encuentra y el error de abajo lo rechaza. Se sigue
      // avisando —nunca bloqueando— cuando el suelo está por encima incluso del hub medido, porque
      // declarar un core que aún no ha salido es la forma CORRECTA de publicar lo que lo necesita.
      warnings.push(
        `compatibility.min_erplora_version = ${declared} es más nuevo que cualquier hub CONOCIDO ` +
          `(el último es ${newestHub.hub}), así que no se puede comprobar el sello ${stamp} contra ` +
          'él. Se deja pasar a propósito: declarar un core que aún no ha salido es la forma ' +
          'CORRECTA de publicar un módulo que lo necesita, y el hub rechaza la instalación en los ' +
          'viejos (hub#521). ' +
          (measured
            ? `El hub consultado dice ser ${source.hub}: apunta \`ERPLORA_HUB_URL\` a uno que ya ` +
              `lleve ${declared} y esto se comprobará de verdad.`
            : 'Añade el tag a `HUB_OUTFITKIT` cuando se publique.'),
      );
      return { errors, warnings };
    }
    if (compareOutfitkitVersions(stamp, floor.outfitkit) > 0) {
      const older = compareOutfitkitVersions(floor.hub, declared) > 0 ? ` (el más antiguo ≥ ${declared})` : '';
      errors.push(
        `el módulo se horneó contra OutfitKit ${stamp}, pero dice correr desde el core ` +
          `${declared}${older}: el hub ${floor.hub} lleva OutfitKit ${floor.outfitkit} ` +
          `(${provenanceOf(floor)}), y los ` +
          '`ok-*` que pintan son los del SHELL, no los del bundle (ADR-0133). Ahí la pantalla sale ' +
          `distinta de como la probaste, sin que nada falle. ${howToDeclare}`,
      );
    }
    return { errors, warnings };
  }

  if (compareOutfitkitVersions(stamp, newestHub.outfitkit) > 0) {
    const said =
      `el módulo se horneó contra OutfitKit ${stamp} y no declara ` +
      '`compatibility.min_erplora_version`, o sea que dice correr en CUALQUIER hub — pero el más ' +
      `nuevo que existe (${newestHub.hub}) lleva OutfitKit ${newestHub.outfitkit} ` +
      `(${provenanceOf(newestHub)}), ` +
      'así que no hay ' +
      'uno solo que pueda pintarlo. Los `ok-*` que pintan son los del SHELL, no los del bundle ' +
      '(ADR-0133): la pantalla sale rota en casa del cliente y él no puede arreglarlo. ';
    // El trinquete de la cabecera: en `validate` es aviso porque el sello lo pone el checkout
    // compartido, no el autor; en `pack` es rojo porque ahí es donde el zip sale hacia un cliente.
    if (publishing) errors.push(`${said}${howToDeclare}`);
    else {
      warnings.push(
        `${said}NO se bloquea aquí a propósito: el sello sale del checkout compartido ` +
          '`../outfitkit`, que va por delante de la flota por diseño, así que un rojo en `validate` ' +
          'pararía a todo módulo que toque su UI por la cadencia de release del hub. Donde SÍ para ' +
          `es en \`erplora pack\`, antes de que el zip llegue a un cliente. ${howToDeclare}`,
      );
    }
  }
  return { errors, warnings };
}
