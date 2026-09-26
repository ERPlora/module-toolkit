import { LitElement, html, css, nothing, svg } from 'lit';
import { ionTone } from '../../lib/ion-tone';
import { state } from 'lit/decorators.js';
import { code128b } from '../../lib/code128';
import { printBarcodeLabel } from '../../lib/barcode-print';
import { formatQuantity, fromMicro, onGrid, parseQuantity } from '../../lib/quantity';
import { hubDecimals, majorToMinor, minorToInput, moneyStep } from '../../lib/hub-currency';
import { resolveTaxCategories, pickTaxValue, normalizeAlias, learnAlias, createCategoryWithAlias } from '../../lib/tax-resolve';
// La etiqueta del selector de categoría fiscal (inventory#58): nombre + tipo aplicable, SIN la
// clave técnica. El % se trae de `taxes` por su query pública; aquí no se recalcula nada.
import { loadTaxRates, taxCategoryOptionLabel, type TaxRate } from '../../lib/tax-category-option';
// `define` por su subpath ligero: importar el barrel '@erplora/outfitkit' arrastraría (efectos
// secundarios) el registro de TODOS los ok-* al bundle del módulo. `ok-data-table` se importa por
// su efecto secundario (se auto-registra). Tipos desde el barrel (se borran en build).
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-inline-feedback';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn, DataTableAction } from '@erplora/outfitkit';
// The major ↔ minor boundary lives in ONE place (`lib/hub-currency`, on top of the SDK, ADR-0123):
// having it copied is what made the CSV import forget the ×100 and store a 2,20 € coffee as 2
// cents; having it hard-coded to two decimals stored a 480 ¥ tea as 48000 ¥ (inventory#101).
import { createListController, dataTableLabels } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
// Catálogo i18n del módulo (ADR-0055): esbuild inlinea estos JSON en el `dist` del WC. Los textos
// internos se resuelven con `erplora.t(CATALOG, 'ui.clave')` (idioma activo, fallback locale→en→clave).
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';
const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

// Web Component del módulo `inventory` (Lit). Mini-app: lista de productos paginada server-side
// (búsqueda + orden + filtro por columna vía el runtime) + alta rápida.
//
// 90% de la lógica vive en Rust: este componente NO toca la BD; llama al SDK
// (erplora.query/queryPage/command/on). El cliente se obtiene de `globalThis.erplora`.

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  /** TODAS las filas, sin tope (salvo que pases `limit`). Para lo que no es «una página»: la
   *  rejilla de productos del TPV, un `<ion-select>` de categorías fiscales, el mapa
   *  producto↔categoría. El viejo `page_size` NO era un parámetro del runtime: truncaba a 50. */
  queryAll<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T[]>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
  hasPermission?(permission: string): boolean;
  /** i18n del módulo (ADR-0055): idioma activo + traducción del catálogo `ui`. */
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
  /** Moneda del hub + formateo de dinero (ADR-0059). `formatMoney` recibe CÉNTIMOS y divide;
   *  `formatAmount` recibe unidades enteras (euros) y NO divide. Precios de BD = céntimos
   *  (ADR-0007) → SIEMPRE `formatMoney`. */
  currency: string;
  formatMoney(cents: number, opts?: { currency?: string; locale?: string }): string;
  formatAmount(units: number, opts?: { currency?: string; locale?: string }): string;
}

interface Product {
  id: string;
  name: string;
  sku: string;
  price: number;
  cost: number;
  stock: number;
  low_stock_threshold: number;
  unit_code?: string;
  tax_category_key: string | null;
  is_active: number;
  /** 1 = the product still has no fiscal category (projected by `queries/products_list.sql`). */
  needs_tax_setup?: number;
  /** Per-item stock control (inventory#48): 1/0 explicit, null = follows the hub setting. */
  track_stock?: number | null;
}

/** Value of the status filter that means «the product does not know how it is taxed» (inventory#38). */
const STATUS_UNCONFIGURED = 'unconfigured';

/**
 * `?status=<name>` → the value the status column's dropdown carries (inventory#72).
 *
 * The three states are exclusive on screen but travel to the server on TWO columns (`is_active` and
 * `needs_tax_setup`), so the URL names the STATE and `applyStatusFilter` is the only thing that
 * knows how a state becomes filters. The names are the ones a person would write, not the column
 * values: `?status=inactive` beats `?is_active=0` for a link that lives in another module's screen.
 *
 * Anything not in here is IGNORED and the catalogue opens whole — an unknown value must never
 * produce an empty list with nothing on screen to explain it.
 */
const STATUS_FROM_QUERY: Record<string, string> = {
  [STATUS_UNCONFIGURED]: STATUS_UNCONFIGURED,
  active: '1',
  inactive: '0',
};

/** The status the URL asks the list to open on, or `''` for «the whole catalogue». */
export function statusFilterFromSearch(search: string): string {
  try {
    return STATUS_FROM_QUERY[new URLSearchParams(search).get('status') ?? ''] ?? '';
  } catch {
    // A malformed query string is not a reason to leave the manager without a catalogue.
    return '';
  }
}

/**
 * Row status for the list: the two lifecycle states of always PLUS a third one, «not configured»
 * (inventory#38). A product created before the fiscal category became mandatory does not know
 * whether it is 21%, 10% or exempt; painting it as «active» is a lie the cashier pays for at the
 * till. Those products are not migrated (assigning them a default category would be making up
 * fiscal data): they are shown, with the reason, and can be filtered to be reviewed in one go.
 */
function statusOf(row: Record<string, unknown>): 'active' | 'inactive' | typeof STATUS_UNCONFIGURED {
  const key = row.tax_category_key;
  // The empty string is the same hole as NULL — mirrors the CASE in `products_list.sql`.
  if (key == null || String(key).trim() === '') return STATUS_UNCONFIGURED;
  // `Number(...)`: un adaptador que devuelva `is_active` como texto mandaría un `'0'` TRUTHY, y un
  // producto desactivado se pintaría activo.
  return Number(row.is_active) ? 'active' : 'inactive';
}

// Fila de `taxes.categories.list` (la CATEGORÍA fiscal es lo enlazable, ADR-0085). El selector del
// formulario y el modal del importador eligen una `key` canónica; el % lo resuelve `taxes` por país.
// `display_name` es la etiqueta ya traducida al idioma del hub (taxes#38): se PINTA esa y se GUARDA
// la `key`, que es lo que no cambia (inventory#64).
interface TaxCategory {
  id: string;
  key: string;
  name: string;
  display_name?: string;
  is_system?: number;
}

// Fila de `inventory.units.list` (registro de unidades, ADR-0147). El selector de la ficha
// solo necesita el código y los nombres; factor/incremento los valida Rust.
interface Unit {
  id: string;
  code: string;
  name: string;
  name_es: string;
  increment_value?: number;
}


// ── Importador CSV: mapeo de columnas (inventory#13) ────────────────────────────────────
//
// Un CSV real no viene con NUESTRAS cabeceras. El listado de precios que trae el cliente dice
// «Nombre;Código;Precio», y hasta ahora eso importaba CERO filas: el código leía `r.name`/`r.sku`
// directamente, así que todas fallaban por «falta nombre o SKU» y el usuario solo veía el informe
// de errores, sin ninguna manera de decir qué columna era cuál.
//
// El paso de mapeo es lo que hace todo el mercado (Odoo, WooCommerce, Lightspeed, Square): se
// adivina por la cabecera y se deja cambiar a mano. `''` = no importar esa columna.

/** Campo de destino de una columna del CSV. `tax` viaja como `tax_category_key` (ADR-0085). */
const IMPORT_FIELDS = [
  'name', 'sku', 'price', 'cost', 'stock', 'low_stock_threshold',
  'ean13', 'description', 'unit_code', 'tax',
] as const;
type ImportField = (typeof IMPORT_FIELDS)[number];

/** Sin las columnas obligatorias no se importa nada (misma regla que Lightspeed y WooCommerce). */
const IMPORT_REQUIRED: ImportField[] = ['name', 'sku'];

/** Cabeceras que se reconocen solas. Inglés (fuente) + español, que es lo que llega de verdad. */
const IMPORT_ALIASES: Record<ImportField, string[]> = {
  name: ['name', 'nombre', 'producto', 'product', 'articulo', 'item', 'titulo'],
  sku: ['sku', 'codigo', 'code', 'referencia', 'ref', 'reference', 'cod'],
  price: ['price', 'precio', 'pvp', 'precio venta', 'sale price', 'precio de venta'],
  cost: ['cost', 'coste', 'costo', 'precio coste', 'purchase price', 'precio de compra'],
  stock: ['stock', 'existencias', 'cantidad', 'qty', 'quantity', 'unidades'],
  low_stock_threshold: ['low_stock_threshold', 'umbral', 'minimo', 'stock minimo', 'min stock', 'reorder point'],
  ean13: ['ean13', 'ean', 'barcode', 'codigo de barras', 'gtin', 'codigo barras'],
  description: ['description', 'descripcion', 'detalle', 'notas'],
  unit_code: ['unit_code', 'unidad', 'unit', 'medida', 'uom'],
  tax: ['tax_category', 'tax_category_key', 'category_tax', 'fiscal_category', 'tax', 'iva', 'vat',
        'impuesto', 'tax_class', 'categoria fiscal', 'tipo de iva'],
};

/** minúsculas, sin tildes y sin espacios de sobra: «Código» y «codigo» son la misma cabecera. */
function normalizeHeader(header: string): string {
  return (header ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

/** Adivina el destino de cada cabecera del fichero; lo que no reconoce queda sin mapear (`''`). */
export function guessMapping(headers: string[]): Record<string, ImportField | ''> {
  const out: Record<string, ImportField | ''> = {};
  const taken = new Set<ImportField>();
  for (const header of headers) {
    const norm = normalizeHeader(header);
    const field = IMPORT_FIELDS.find(
      (f) => !taken.has(f) && IMPORT_ALIASES[f].some((a) => normalizeHeader(a) === norm),
    );
    out[header] = field ?? '';
    if (field) taken.add(field);
  }
  return out;
}

/** Reescribe las filas con NUESTRAS claves según el mapeo; la columna no mapeada se cae. */
export function applyMapping(
  rows: Record<string, string>[],
  mapping: Record<string, ImportField | ''>,
): Record<string, string>[] {
  return rows.map((row) => {
    const out: Record<string, string> = {};
    for (const [header, field] of Object.entries(mapping)) {
      if (!field) continue;
      // `tax` es la única que no se llama igual: viaja con el nombre que `pickTaxValue` reconoce.
      out[field === 'tax' ? 'tax_category_key' : field] = row[header] ?? '';
    }
    return out;
  });
}

/** Filas de la vista previa: bastantes para ver que el mapeo es el bueno, pocas para caber. */
const PREVIEW_ROWS = 5;

/**
 * Texto de dinero de un CSV → número, **con la coma decimal española** (inventory#13).
 *
 * `Number('2,20')` es `NaN`, así que un listado de precios español —que es el que trae el cliente
 * de aquí— fallaba fila por fila con «precio no válido». Reglas, en el orden en que se aplican:
 *
 *  - con los DOS separadores (`1.234,56` / `1,234.56`), manda el de más a la derecha: ese es el
 *    decimal y el otro son los miles;
 *  - con solo comas, la coma es el decimal (`2,20`);
 *  - con solo puntos se deja como está: `2.20` ya se leía bien y cambiarlo ahora rompería los
 *    ficheros que hoy entran.
 *
 * Devuelve `null` cuando el texto no es un número — que es distinto de vacío (0) y por eso la fila
 * se rechaza con su motivo en vez de guardar un precio inventado.
 */
export function parseMoneyText(text: string | undefined): number | null {
  const raw = (text ?? '').trim();
  if (raw === '') return 0;
  // A currency with no decimals (JPY) has no decimal separator: «1,200» / «1.200» are thousands
  // groups, not 1,2 ¥ (inventory#101).
  if (hubDecimals() === 0 && /^-?\d{1,3}([.,]\d{3})+$/.test(raw)) return Number(raw.replace(/[.,]/g, ''));
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let normalized = raw;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

/** Visibilidad de UI; el runtime vuelve a validar el permiso en cada command. */
function can(permission: string): boolean {
  const client = erplora();
  return typeof client.hasPermission === 'function' ? client.hasPermission(permission) : true;
}

export class ErpInventoryProducts extends LitElement {
  static styles = css`
    :host { display:flex; flex-direction:column; height:100%; min-height:0; font-family: system-ui, sans-serif; color: var(--ion-text-color, #1c1b18); }
    /* La vista llena el alto: el data-table ocupa todo (scroll interno, footer fijo). */
    .page { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; }
    .page > ok-data-table { flex:1 1 auto; min-height:0; }
    .form { display:flex; flex-direction:column; gap:.7rem; }
    .form ion-button { align-self:flex-end; }
    .track-note { font-size:.8rem; color:var(--ion-color-medium,#6b6557); margin-top:-.4rem; }
    .err { color:#d9480f; font-weight:600; }
    /* Detalle de producto */
    .detail { display:flex; flex-direction:column; gap:.6rem; }
    .drow { display:flex; justify-content:space-between; border-bottom:1px solid var(--ion-border-color,#eee); padding:.4rem 0; }
    .drow span { color:var(--ion-color-medium,#6b6557); }
    /* Sin reglas .barcode/.bc/.bccode a propósito (inventory#45): el código de barras vive dentro
       del ion-modal del detalle, que Ionic REPARENTA a body, así que esas reglas del shadow no le
       llegarían nunca. La placa se estila INLINE donde se pinta. */
  `;

  @state() newName = '';
  @state() newSku = '';
  @state() newPrice = '';
  @state() private newTaxCategoryKey = ''; // '' = sin categoría (se envía null)
  // Ficha completa (inventory#8): el form de alta/edición cubre TODOS los campos del dominio.
  @state() newCost = '';
  @state() newStock = '';
  @state() newThreshold = '';
  @state() newEan = '';
  @state() newDescription = '';
  @state() newType: 'physical' | 'service' = 'physical';
  @state() newActive = true;
  // Stock control PER ITEM (inventory#48, market: Square/Odoo/Shopify). Tri-state like ADR-0210:
  // 1/0 = the item decided; null = follows the hub setting. Untouched on create → null, so the
  // item keeps following the hub if the hub changes its mind later (never frozen at creation).
  @state() newTrackStock: 0 | 1 | null = null;
  /** The hub default (`inventory.settings.get`, best-effort — the setting needs manage_settings). */
  @state() hubTracksStock = true;
  // Unidad maestra de inventario (ADR-0147): default 'ud' (la unidad suelta). Se envía SIEMPRE
  // (create y update): tras el COALESCE del comando, reenviar la actual es idempotente.
  @state() newUnitCode = 'ud';
  @state() private units: Unit[] = [];
  // Edición REAL (inventory#8): id en edición (null = alta). Estado técnico Y visible
  // (el form cambia de título/botón). El submit decide create vs update por esto.
  @state() editingId: string | null = null;
  /** pm#459: each edit opening takes a number; cancel/reset/«Add» bumps it. An opening that is no
   *  longer the LAST one stops right after each await, so a stale reply never overwrites a newer
   *  edit's form, id or header. */
  private editSeq = 0;
  /** pm#450: whether the table's panel HEADER already carries the editing title (OutfitKit
   *  ≥ 0.1.94, outfitkit#150). Set only after checking the rendered dialog — never assumed — so
   *  an older shell (hub:stable ships 0.1.73, which ignores the `title` and keeps «New») still
   *  gets the fallback line in the form body. */
  @state() editTitleInHeader = false;
  // Categorías del producto (M2M): marcadas en el form; initial = las de BD al abrir la
  // edición, para sincronizar solo las diferencias (add/remove).
  @state() selectedCategoryIds: Set<string> = new Set();
  initialCategoryIds: Set<string> = new Set();
  @state() private productCategories: { id: string; name: string }[] = [];
  @state() private taxCategories: TaxCategory[] = [];
  /** `tax_category_key → {pct, exempt}` traído de `taxes` (inventory#58). Vacío = sin catálogo
   *  fiscal: las opciones salen con su nombre a secas, pero el alta sigue viva. */
  @state() private taxRates: Map<string, TaxRate> = new Map();
  @state() private saving = false;
  @state() private formError = '';

  // ── Importador CSV: resolución interactiva de categorías no reconocidas (ADR-0085) ──
  // Cuando el CSV trae un texto de categoría que no resuelve por alias/categoría, en vez de dejar
  // la fila sin categoría, se abre un modal para que el usuario decida (elegir existente / crear
  // nueva); la decisión se persiste como alias (`taxes.aliases.create` / `taxes.categories.create`)
  // para que la próxima importación resuelva sola.
  @state() private importOpen = false;
  @state() private importRows: Record<string, string>[] = []; // filas pendientes de crear
  @state() private importMap: Map<string, string> = new Map(); // textoNormalizado → key (ya resuelto)
  @state() private importUnresolved: string[] = []; // textos a decidir
  // Decisión por texto: 'skip' (sin categoría), 'pick' (key existente), 'create' (nueva key+name).
  @state() private importChoice: Record<string, { mode: 'skip' | 'pick' | 'create'; key: string; newKey: string; newName: string }> = {};
  // Borrado con confirmación (P1 QA beauty #6, paridad con categorías): nunca directo.
  @state() deleteTarget: Product | null = null;
  // Informe del import (inventory#13): visible al terminar, copiable; null = sin import reciente.
  // `cancelled` = el usuario paró a media importación: lo que ya entró está contado, nunca callado.
  @state() importReport: { total: number; created: number; skipped: number; cancelled?: boolean;
    failed: { line: number; sku: string; reason: string }[] } | null = null;

  // ── Vista previa + mapeo de columnas, ANTES de crear nada (inventory#13) ──
  @state() previewOpen = false;
  @state() previewRows: Record<string, string>[] = [];
  @state() previewMapping: Record<string, ImportField | ''> = {};
  // Progreso de la importación en curso (`x/N`) y su interruptor de parada.
  @state() importProgress: { done: number; total: number } | null = null;
  private importCancelled = false;
  // hub#1737: an import already confirmed. A second tap on «Import» while the modal animates out
  // used to start a second run over rows the first had already cleared — and its report of
  // zeros overwrote the real one.
  private importBusy = false;

  private ctrl!: ListController<Product>;
  private unsub?: () => void;

  // Getter (no campo): se re-evalúa en cada render, así los textos cambian con el idioma activo
  // (ADR-0055). `connectedCallback` re-renderiza al recibir `erplora:locale-changed`.
  private get columns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
    { key: 'name', header: t('ui.name'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'sku', header: t('ui.sku'), sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'price',
      header: t('ui.price'),
      align: 'right',
      sortable: true,
      filterable: true,
      filterType: 'range',
      // El precio está en CÉNTIMOS → `formatMoney` (divide). `formatAmount` NO divide: con él,
      // un café de 220 céntimos se pintaba «220,00 €».
      format: (r) => erplora().formatMoney(Number(r.price)),
    },
    {
      key: 'stock',
      header: t('ui.stock'),
      align: 'right',
      sortable: true,
      filterable: true,
      filterType: 'range',
      // inventory#48: an item that does not track stock has no balance worth showing.
      format: (r) => (this.rowTracksStock(r) ? formatQuantity(Number(r.stock)) : '—'),
    },
    {
      key: 'is_active',
      header: t('ui.status'),
      align: 'center',
      filterable: true,
      filterType: 'select',
      // TRES estados, no dos (inventory#38). El tercero no es una columna aparte a propósito: si
      // «sin configurar» viviera al lado del toggle, un producto que no se puede vender seguiría
      // pintándose «activo» — que es exactamente la mentira que costaba una venta en el mostrador.
      options: [
        { value: '1', label: t('ui.yes') },
        { value: '0', label: t('ui.no') },
        { value: STATUS_UNCONFIGURED, label: t('ui.statusUnconfigured') },
      ],
      render: (r) => {
        if (statusOf(r) === STATUS_UNCONFIGURED) return this.renderUnconfigured(r);
        // Celda interactiva: ion-toggle (verde = activo). Al cambiar, persiste vía command.
        // El color va por CSS var (--background-checked) y no por `color=`, porque las clases
        // .ion-color-* no penetran el shadow DOM de ok-data-table; las custom props sí heredan.
        return can('inventory.change_product')
          ? html`
              <ion-toggle
                data-testid=${`inventory-products-active-${r.id}`}
                aria-label=${t('ui.active')}
                style="--track-background-checked: rgba(var(--ion-color-success-rgb, 45,211,111), 0.5); --handle-background-checked: var(--ion-color-success, #2dd36f);"
                ?checked=${!!r.is_active}
                @ionChange=${(e: Event) => this.toggleActive(r as unknown as Product, e)}
              ></ion-toggle>
            `
          : (r.is_active ? t('ui.yes') : t('ui.no'));
      },
    },
    ];
  }

  /**
   * Estado de la fila para la columna de estado, ya traducido. Público (y puro) para que el
   * contrato del TERCER estado se pueda fijar en un test sin renderizar la tabla entera.
   */
  productStatus(row: Record<string, unknown>): { id: string; label: string; reason: string } {
    const t = (k: string): string => erplora().t(CATALOG, k);
    const id = statusOf(row);
    if (id === STATUS_UNCONFIGURED) {
      return { id, label: t('ui.statusUnconfigured'), reason: t('ui.statusUnconfiguredReason') };
    }
    return { id, label: id === 'active' ? t('ui.yes') : t('ui.no'), reason: '' };
  }

  /** Celda del tercer estado: DICE el motivo y, con permiso, es el atajo para arreglarlo. */
  private renderUnconfigured(row: Record<string, unknown>) {
    const { label, reason } = this.productStatus(row);
    const editable = can('inventory.change_product');
    return html`
      <ion-chip
        data-testid=${`inventory-products-unconfigured-${row.id}`}
        title=${reason}
        ?disabled=${!editable}
        style=${`${ionTone('chip', 'warning')}${editable ? ' cursor:pointer;' : ''}`}
        @click=${() => editable && this.onRowAction(
          new CustomEvent('rowAction', { detail: { actionId: 'edit', row } }),
        )}
      >
        <ion-icon name="alert-circle-outline" style="color: inherit"></ion-icon>
        <ion-label>${label} · ${reason}</ion-label>
      </ion-chip>
    `;
  }

  /**
   * Filtro de estado: los TRES valores son EXCLUYENTES entre sí, pero viajan al servidor por DOS
   * columnas distintas (`is_active` y `needs_tax_setup`), así que se aplican juntos y con UNA sola
   * recarga — encadenar dos `setFilter` haría dos viajes y dejaría el filtro anterior puesto en el
   * primero de ellos.
   */
  applyStatusFilter(value: unknown): void {
    const v = value == null ? '' : String(value);
    delete this.ctrl.state.filters.is_active;
    delete this.ctrl.state.filters.needs_tax_setup;
    if (v === STATUS_UNCONFIGURED) this.ctrl.state.filters.needs_tax_setup = '1';
    else if (v !== '') this.ctrl.state.filters.is_active = v;
    // Lo que la TABLA enseña es el valor del desplegable, no el que viaja al servidor: los tres
    // estados son una sola columna en pantalla y dos en la query (inventory#83).
    this.setTableFilter('is_active', v);
    this.ctrl.state.page = 0;
    void this.ctrl.load();
  }

  /**
   * Lo que los controles de filtro de `ok-data-table` tienen que ENSEÑAR, por clave de columna
   * (inventory#83, deriva de outfitkit#106/#107).
   *
   * En modo servidor la tabla no guarda estado de filtro propio —sus controles pintaban desde
   * `clientFilters`, que un `serverSide` nunca escribe—, así que una lista acotada desde la URL
   * salía con el desplegable EN BLANCO y parecía un catálogo de doce artículos. Desde 0.1.57 la
   * librería acepta `filterValues` y este es el estado que se le pasa.
   *
   * No es `ctrl.state.filters`: ese es el estado del SERVIDOR (`needs_tax_setup=1`), una clave que
   * el desplegable de estado ni siquiera ofrece.
   */
  @state() private tableFilters: Record<string, unknown> = {};

  /**
   * Fija (o borra) el valor visible de una columna.
   *
   * Asigna siempre un objeto NUEVO: `ok-data-table` resiembra su espejo por identidad y una
   * mutación in-place no le llega —a propósito, para que las elecciones del usuario manden
   * mientras el consumidor no diga otra cosa—, así que mutando esto el control se quedaría con el
   * valor viejo. Y se copia el objeto entero, no solo la clave que cambia: la resiembra sustituye
   * el espejo completo, así que un `{is_active}` a secas borraría de la pantalla el filtro de
   * `sku` que el usuario acababa de escribir, dejando la lista acotada por algo invisible.
   */
  private setTableFilter(col: string, value: unknown): void {
    const next = { ...this.tableFilters };
    const empty =
      value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
    if (empty) delete next[col];
    else next[col] = value;
    this.tableFilters = next;
  }

  @state() private detail: Product | null = null;
  /** Por qué no salió la etiqueta (inventory#44). Se pinta en el propio modal del detalle. */
  @state() private printError = '';

  // ── Recuento y recepción (inventory#7) ──────────────────────────────────────
  // Estado de los dos modales de stock. El recuento es ABSOLUTO: se enseña la
  // DIFERENCIA contra el stock actual ANTES de aplicar, y el motivo es obligatorio.
  @state() countTarget: Product | null = null;
  @state() countValue = '';
  @state() countReason = '';
  @state() receiveTarget: Product | null = null;
  @state() receiveQty = '';
  @state() receiveCost = '';

  /** Diferencia del recuento (nuevo − actual), o null si aún no hay valor tecleado. */
  get countDifference(): number | null {
    if (!this.countTarget || this.countValue.trim() === '') return null;
    const raw = parseQuantity(this.countValue);
    if (raw === null || !this.quantityMatchesUnit(raw, this.countTarget.unit_code)) return null;
    return fromMicro(raw - Number(this.countTarget.stock));
  }

  async submitCount(): Promise<void> {
    if (!can('inventory.adjust_stock') || !this.countTarget || this.countValue.trim() === '' || this.countReason.trim() === '') return;
    const raw = parseQuantity(this.countValue);
    if (raw === null) {
      this.formError = erplora().t(CATALOG, 'ui.errQuantity');
      return;
    }
    if (!this.quantityMatchesUnit(raw, this.countTarget.unit_code)) {
      this.formError = erplora().t(CATALOG, 'ui.errQuantityGrid');
      return;
    }
    try {
      await erplora().command('inventory.stock.adjust', {
        product_id: this.countTarget.id,
        stock: raw,
        reason: this.countReason.trim(),
      });
      this.countTarget = null;
      this.countValue = '';
      this.countReason = '';
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errCount');
    }
  }

  async submitReceive(): Promise<void> {
    if (!can('inventory.adjust_stock') || !this.receiveTarget || this.receiveQty.trim() === '') return;
    const qty = parseQuantity(this.receiveQty);
    if (qty === null || qty <= 0) {
      this.formError = erplora().t(CATALOG, 'ui.errQuantity');
      return;
    }
    if (!this.quantityMatchesUnit(qty, this.receiveTarget.unit_code)) {
      this.formError = erplora().t(CATALOG, 'ui.errQuantityGrid');
      return;
    }
    // The cost is typed in MAJOR units and stored in the hub currency's MINOR units (ADR-0007/0123,
    // inventory#101): a fixed `× 100` stored a 480 ¥ cost as 48000 ¥.
    const cost = this.receiveCost.trim() === '' ? null : majorToMinor(Number(this.receiveCost));
    try {
      await erplora().command('inventory.stock.receive', {
        items: [{ product_id: this.receiveTarget.id, qty, unit_cost: cost }],
      });
      this.receiveTarget = null;
      this.receiveQty = '';
      this.receiveCost = '';
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errReceive');
    }
  }

  // Acciones por fila (botones) → la tabla emite `rowAction` con { actionId, row }. Getter (i18n).
  get actions(): DataTableAction[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { id: 'detail', label: t('ui.actionDetail'), icon: 'eye-outline' },
      ...(can('inventory.adjust_stock')
        ? [
            { id: 'receive', label: t('ui.actionReceive'), icon: 'download-outline' },
            { id: 'count', label: t('ui.actionCount'), icon: 'calculator-outline' },
          ]
        : []),
      ...(can('inventory.change_product')
        ? [{ id: 'edit', label: t('ui.actionEdit'), icon: 'create-outline' }]
        : []),
      ...(can('inventory.delete_product')
        ? [{ id: 'delete', label: t('ui.actionDelete'), icon: 'trash-outline', color: 'danger' }]
        : []),
    ];
  }

  private async onRowAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>): Promise<void> {
    const { actionId, row } = ev.detail;
    const p = row as unknown as Product;
    if (actionId === 'detail') {
      this.detail = p; // abre el modal de detalle (con código de barras)
    } else if (actionId === 'receive' && can('inventory.adjust_stock')) {
      this.receiveTarget = p;
    } else if (actionId === 'count' && can('inventory.adjust_stock')) {
      this.countTarget = p;
      this.countValue = '';
      this.countReason = '';
    } else if (actionId === 'edit' && can('inventory.change_product')) {
      // REAL edit (inventory#8): loads the FULL product from products.get (the list row does not
      // project description/ean13) + its current M2M categories, and sets editingId.
      //
      // pm#459: two «edit» taps in a row race their own awaits (products.get, product_categories,
      // the table render), and they can settle in either order. Each opening claims a `seq` and
      // loads into LOCALS first; only once it is confirmed to still be the LAST opening does it
      // touch `this.*` — so a stale reply stops instead of overwriting the newer edit.
      const seq = ++this.editSeq;
      let full: Product = p;
      try {
        full = (await erplora().query<Product[]>('inventory.products.get', { product_id: p.id }))?.[0] ?? p;
      } catch {
        // The list row is enough to pre-fill: description/ean13 just stay blank.
      }
      let mine: string[] = [];
      try {
        const links = await erplora().query<{ product_id: string; category_id: string }[]>('inventory.product_categories');
        mine = (Array.isArray(links) ? links : []).filter((l) => l.product_id === p.id).map((l) => l.category_id);
      } catch {
        mine = [];
      }
      // A newer opening (another row's edit, or a cancel/reset/«Add») already moved the sequence
      // on: this reply belongs to a form nobody is looking at anymore.
      if (seq !== this.editSeq) return;
      this.editingId = p.id;
      this.newName = full.name ?? '';
      this.newSku = full.sku ?? '';
      // The DB stores the hub currency's MINOR units and the form edits MAJOR ones (ADR-0123,
      // inventory#101: in a yen hub there is nothing to divide).
      this.newPrice = minorToInput(full.price);
      this.newCost = minorToInput((full as unknown as { cost?: number }).cost ?? 0);
      this.newThreshold = formatQuantity(
        (full as unknown as { low_stock_threshold?: number }).low_stock_threshold ?? 10_000_000,
      );
      this.newEan = String((full as unknown as { ean13?: string | null }).ean13 ?? '');
      this.newDescription = String((full as unknown as { description?: string }).description ?? '');
      this.newType = ((full as unknown as { product_type?: string }).product_type === 'service' ? 'service' : 'physical');
      this.newActive = Number((full as unknown as { is_active?: number }).is_active ?? 1) === 1;
      const rawTrack = (full as unknown as { track_stock?: number | string | null }).track_stock;
      this.newTrackStock = rawTrack == null || rawTrack === '' ? null : Number(rawTrack) !== 0 ? 1 : 0;
      this.newUnitCode = String((full as unknown as { unit_code?: string }).unit_code || 'ud');
      this.newTaxCategoryKey = full.tax_category_key ?? '';
      this.initialCategoryIds = new Set(mine);
      this.selectedCategoryIds = new Set(mine);
      const title = `${erplora().t(CATALOG, 'ui.editingTitle')} — ${this.newName}`;
      const table = this.dataTable();
      table?.open('edit', { title });
      await table?.updateComplete;
      // A newer opening may have taken over WHILE the table rendered: its own render already
      // titled the header and this reply must not repaint the stale line back on top of it.
      if (seq !== this.editSeq) return;
      // OutfitKit < 0.1.94 ignores the title and keeps «New»: only drop the in-form line when the
      // header REALLY carries it (the dialog is labelled with it).
      this.editTitleInHeader = table?.shadowRoot?.querySelector('[role="dialog"]')?.getAttribute('aria-label') === title;
    } else if (actionId === 'delete' && can('inventory.delete_product')) {
      // Nunca borra directo (P1 QA #6): confirmación, como el borrado de categorías.
      this.deleteTarget = p;
    }
  }

  /** Ejecuta el borrado confirmado. */
  async confirmDelete(): Promise<void> {
    if (!this.deleteTarget) return;
    try {
      await erplora().command('inventory.products.delete', { product_id: this.deleteTarget.id });
      this.deleteTarget = null;
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errDeleteProduct');
      this.deleteTarget = null;
    }
  }

  private async toggleActive(p: Product, ev: Event): Promise<void> {
    if (!can('inventory.change_product')) return;
    const checked = (ev.target as HTMLInputElement).checked;
    try {
      // El command exige el conjunto COMPLETO de campos editables (schemas/product_update.json,
      // inventory#8): la fila de la lista no proyecta description/ean13, así que se lee la
      // ficha completa antes — reenviar un subconjunto BORRARÍA esos campos.
      const full = (await erplora().query<Record<string, unknown>[]>('inventory.products.get', { product_id: p.id }))?.[0] ?? {};
      await erplora().command('inventory.products.update', {
        product_id: p.id,
        name: p.name,
        price: p.price,
        cost: p.cost ?? 0,
        low_stock_threshold: p.low_stock_threshold ?? 10,
        ean13: (full.ean13 as string | null) ?? null,
        description: (full.description as string) ?? '',
        // De la ficha COMPLETA (autoridad), no de la fila: desde inventory#38 el command exige
        // una categoría no vacía, y un reenvío en blanco tumbaría el toggle con un error de schema.
        tax_category_key: (full.tax_category_key as string | undefined) ?? p.tax_category_key,
        is_active: checked ? 1 : 0,
      });
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errUpdateProduct');
    }
  }

  // Referencia al ok-data-table para abrir/cerrar su panel lateral (drawer).
  private dataTable(): {
    open(p?: 'filters' | 'create' | 'edit', opts?: { title?: string }): void;
    close(): void;
    updateComplete?: Promise<unknown>;
    shadowRoot: ShadowRoot | null;
  } | null {
    return this.renderRoot.querySelector('ok-data-table') as
      | {
          open(p?: 'filters' | 'create' | 'edit', opts?: { title?: string }): void;
          close(): void;
          updateComplete?: Promise<unknown>;
          shadowRoot: ShadowRoot | null;
        }
      | null;
  }

  // Importa productos desde CSV (cabeceras = name, sku, price, stock…). Crea uno por fila.
  // Cada fila resuelve su tipo de IVA por referencia (ADR-0066): la columna fiscal (tax/iva/vat/…)
  // se matchea contra los tipos existentes de `taxes`, los que falten (con un % real) se crean en
  // bloque, y el producto enlaza por `tax_category_key`. Vacío / sin columna → null = tipo por defecto
  // del hub. NO se convierten precios: "IVA incluido o no" lo gobierna el ajuste del hub/POS.
  async onCsvImport(ev: CustomEvent<{ rows: Record<string, string>[] }>): Promise<void> {
    if (!can('inventory.import_product') || !can('inventory.add_product')) return;
    const rows = ev.detail.rows ?? [];
    if (rows.length === 0) return;
    // NADA se crea al soltar el fichero (inventory#13): primero se enseña qué se ha entendido —
    // qué columna es qué, cómo quedan las primeras filas y cuántas están listas— y se confirma.
    // Es el paso que tienen Odoo («Test import»), WooCommerce y Lightspeed (mapeo obligatorio de
    // las columnas requeridas) y Shopify (resumen antes de confirmar).
    this.previewRows = rows;
    this.previewMapping = guessMapping(Object.keys(rows[0] ?? {}));
    this.previewOpen = true;
    if (this.units.length === 0) await this.loadUnits();
  }

  /** Filas del fichero ya con NUESTRAS claves, según el mapeo elegido. */
  private get mappedPreviewRows(): Record<string, string>[] {
    return applyMapping(this.previewRows, this.previewMapping);
  }

  /** ¿Están mapeadas las columnas sin las que no se puede crear un producto? */
  get previewReady(): boolean {
    const mapped = new Set(Object.values(this.previewMapping));
    return IMPORT_REQUIRED.every((f) => mapped.has(f));
  }

  /**
   * Ensayo: valida TODAS las filas con el mapeo actual sin mandar nada al dispatcher, igual que el
   * «Test import» de Odoo. Lo que aquí sale limpio es lo que entrará; lo que sale con motivo se
   * corrige en el fichero (o en el mapeo) antes de tocar el catálogo.
   */
  get previewSummary(): { ready: number; failed: { line: number; reason: string }[] } {
    const seen = new Set<string>();
    const failed: { line: number; reason: string }[] = [];
    let ready = 0;
    this.mappedPreviewRows.forEach((r, i) => {
      const parsed = this.parseCsvRow(r, seen);
      if ('error' in parsed) failed.push({ line: i + 2, reason: parsed.error });
      else ready++;
    });
    return { ready, failed };
  }

  /** Cierra la vista previa sin efecto ninguno: el fichero se descarta tal cual llegó. */
  cancelPreview(): void {
    this.previewOpen = false;
    this.previewRows = [];
    this.previewMapping = {};
  }

  /** Confirma la vista previa: a partir de aquí, el camino de siempre (categorías fiscales + alta). */
  async confirmPreview(): Promise<void> {
    if (!this.previewReady) return;
    const rows = this.mappedPreviewRows;
    this.previewOpen = false;
    this.previewRows = [];
    await this.startImport(rows);
  }

  /** El usuario pulsa «Cancelar» con la importación en marcha: se para en la fila siguiente. */
  cancelImport(): void {
    this.importCancelled = true;
  }

  private async startImport(rows: Record<string, string>[]): Promise<void> {
    // 1) Resolver la CATEGORÍA fiscal de cada fila (ADR-0085): el CSV trae texto de categoría
    // (food/pizza/…), se resuelve a la clave canónica vía alias/categoría existente.
    let map = new Map<string, string>();
    let unresolved: string[] = [];
    try {
      const res = await resolveTaxCategories(rows, erplora());
      map = res.map;
      unresolved = res.unresolved;
    } catch (e) {
      console.warn('[inventory] No se pudieron resolver las categorías fiscales del CSV:', e);
    }

    // 1b) Las filas que NO traen columna fiscal también necesitan una categoría (inventory#38):
    // sin ella el alta se rechaza. En vez de fallar el fichero entero —que es lo que le pasa al
    // cliente que llega con su listado de precios de toda la vida, sin columna de IVA— se pregunta
    // UNA categoría para todas ellas, por el mismo modal. La cadena vacía es su entrada en el mapa.
    if (rows.some((r) => !pickTaxValue(r)) && !map.has('')) {
      unresolved = [...unresolved, ''];
    }

    // 2) Si hay textos sin resolver → abrir el modal para que el usuario decida (elegir/crear);
    // la creación se aplaza hasta confirmar. Si no hay → crear directamente.
    if (unresolved.length > 0) {
      this.importRows = rows;
      this.importMap = map;
      this.importUnresolved = unresolved;
      const choice: typeof this.importChoice = {};
      for (const u of unresolved) choice[u] = { mode: 'pick', key: '', newKey: '', newName: u };
      this.importChoice = choice;
      // Asegura tener las categorías para el selector del modal.
      if (this.taxCategories.length === 0) await this.loadTaxCategories();
      this.importOpen = true;
      return;
    }
    await this.finalizeImport(rows, map);
  }

  // Aplica las decisiones del modal: por cada texto sin resolver, persiste el alias hacia una
  // categoría existente (learnAlias) o crea una categoría nueva + alias (createCategoryWithAlias),
  // actualiza el mapa y procede con la creación de productos (ADR-0085).
  private async confirmImportResolution(): Promise<void> {
    if (this.importBusy) return;
    this.importBusy = true;
    try {
      await this.resolveAndImport();
    } finally {
      this.importBusy = false;
    }
  }

  private async resolveAndImport(): Promise<void> {
    const map = new Map(this.importMap);
    for (const text of this.importUnresolved) {
      const c = this.importChoice[text];
      try {
        if (c?.mode === 'pick' && c.key) {
          await learnAlias(erplora(), text, c.key);
          map.set(normalizeAlias(text), c.key);
        } else if (c?.mode === 'create' && c.newKey.trim()) {
          const key = c.newKey.trim();
          await createCategoryWithAlias(erplora(), key, (c.newName || key).trim(), text);
          map.set(normalizeAlias(text), key);
        }
        // mode 'skip' (o pick sin key) → la fila queda sin categoría (null).
      } catch (e) {
        console.warn(`[inventory] No se pudo resolver la categoría "${text}":`, e);
      }
    }
    this.importOpen = false;
    await this.loadTaxCategories(); // refresca el selector con las categorías nuevas
    await this.finalizeImport(this.importRows, map);
  }

  // Crea un producto por fila enlazando su tax_category_key resuelto (o null = sin categoría).
  // Importa fila a fila con VALIDACIÓN previa e informe VISIBLE (inventory#13): nada de
  // `catch {}` — cada fila acaba en creada / omitida (duplicado en BD, política definida:
  // se salta y se cuenta, reintentable) / fallida (con línea FÍSICA del fichero y motivo).
  // El resumen se enseña en un modal y es copiable para corregir y reintentar.
  /**
   * Juzga UNA fila y devuelve o su motivo de rechazo o el alta lista para mandar.
   *
   * La misma función la usan el ensayo de la vista previa y la importación de verdad
   * (inventory#13): si fueran dos, el ensayo diría «5 listas» y luego entrarían 3, que es
   * exactamente la clase de mentira que un ensayo tiene que evitar. Lo único que el ensayo no
   * puede saber todavía es la categoría fiscal —se resuelve/pregunta después (ADR-0085)—, así que
   * eso se comprueba fuera, donde ya hay mapa.
   *
   * `seenSkus` se muta a propósito: el duplicado DENTRO del fichero solo existe en el recorrido.
   */
  private parseCsvRow(
    r: Record<string, string>,
    seenSkus: Set<string>,
  ): { error: string } | { sku: string; payload: Record<string, unknown> } {
    const t = (k: string): string => erplora().t(CATALOG, k);
    const sku = (r.sku ?? '').trim();
    const name = (r.name ?? '').trim();

    if (!name || !sku) return { error: t('ui.importErrNameSku') };
    const price = parseMoneyText(r.price);
    const cost = parseMoneyText(r.cost);
    if (price === null || cost === null) return { error: t('ui.importErrPrice') };
    if (seenSkus.has(sku)) return { error: t('ui.importErrDupFile') };
    seenSkus.add(sku);

    const unitCode = (r.unit_code ?? 'ud').trim() || 'ud';
    const stock = r.stock?.trim() ? parseQuantity(r.stock) : 0;
    const threshold = r.low_stock_threshold?.trim() ? parseQuantity(r.low_stock_threshold) : 10_000_000;
    if (stock === null || threshold === null) return { error: t('ui.errQuantity') };
    if (!this.quantityMatchesUnit(stock, unitCode) || !this.quantityMatchesUnit(threshold, unitCode)) {
      return { error: t('ui.errQuantityGrid') };
    }
    return {
      sku,
      payload: {
        name,
        sku,
        price: majorToMinor(price),
        stock,
        cost: majorToMinor(cost),
        low_stock_threshold: threshold,
        product_type: 'physical',
        ean13: r.ean13 || null,
        description: r.description ?? '',
        unit_code: unitCode,
        image: '',
      },
    };
  }

  async finalizeImport(rows: Record<string, string>[], map: Map<string, string>): Promise<void> {
    const t = (k: string): string => erplora().t(CATALOG, k);
    // hub#1737: a run with no rows did nothing, so it has nothing to report. Painting «0 · 0 · 0 · 0»
    // (a second confirm over rows the first run had already consumed) only hid the real report.
    if (rows.length === 0) return;
    const failed: { line: number; sku: string; reason: string }[] = [];
    let created = 0;
    let skipped = 0;
    const seenSkus = new Set<string>();
    // Progreso visible (`x/N`) y parada a petición: con 280 filas, una barra quieta y sin salida
    // es lo único que el usuario ve durante minutos. WooCommerce enseña la barra; Shopify avisa de
    // que su import «cannot be cancelled once started» — aquí sí se puede, y lo que ya entró se
    // cuenta en el informe con la marca de parado.
    this.importCancelled = false;
    this.importProgress = { done: 0, total: rows.length };

    for (let i = 0; i < rows.length; i++) {
      if (this.importCancelled) break;
      this.importProgress = { done: i, total: rows.length };
      const r = rows[i];
      const line = i + 2; // línea física del CSV (la cabecera es la 1)

      const parsed = this.parseCsvRow(r, seenSkus);
      if ('error' in parsed) {
        failed.push({ line, sku: (r.sku ?? '').trim(), reason: parsed.error });
        continue;
      }

      // Categoría fiscal de la fila: la resuelta por su texto, o —si la fila no traía columna— la
      // que el usuario eligió para todas (entrada `''` del mapa). Sin ninguna, la fila NO se manda
      // (inventory#38): el schema la rechazaría con un mensaje de validación que no dice nada, y un
      // producto que no sabe cómo tributa reventaría en el mostrador. Falla aquí, con su motivo.
      const taxCategoryKey = map.get(normalizeAlias(pickTaxValue(r))) ?? null;
      if (!taxCategoryKey) {
        failed.push({ line, sku: parsed.sku, reason: t('ui.importErrTaxCategory') });
        continue;
      }
      try {
        await erplora().command('inventory.products.create', {
          ...parsed.payload,
          tax_category_key: taxCategoryKey,
        });
        created++;
      } catch (e) {
        // Duplicate policy: a product already in the catalogue is OMITTED (counted, never silent).
        // It is decided by LOOKING at the catalogue, not by reading the error: the runtime redacts
        // database errors (hub#1074), so a duplicate SKU arrives as code `db` with a generic line
        // and a text match never fired — the row was reported as failed (hub#1737).
        if (await this.skuInCatalogue(parsed.sku)) {
          skipped++;
        } else {
          failed.push({ line, sku: parsed.sku, reason: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    const cancelled = this.importCancelled;
    this.importProgress = null;
    this.importCancelled = false;
    this.importReport = { total: rows.length, created, skipped, failed, ...(cancelled ? { cancelled } : {}) };
    this.importRows = [];
    this.importUnresolved = [];
    await this.ctrl.load();
  }

  /**
   * Is there already a (not deleted) product with exactly this SKU? The `sku` filter is a LIKE, so
   * the rows it brings are matched exactly here — and ALL of them are read (`queryAll`): a short
   * numeric SKU («1») is contained in many others, and one page of them may not hold it. A lookup
   * that fails answers «no»: the row then stays failed with its reason, which is the honest outcome
   * when nothing could be checked.
   */
  private async skuInCatalogue(sku: string): Promise<boolean> {
    try {
      const rows = await erplora().queryAll<Product>('inventory.products.list', { filters: { sku } });
      return Array.isArray(rows) && rows.some((r) => r.sku === sku);
    } catch {
      return false;
    }
  }

  /** Informe copiable: una línea por fila fallida (`línea N · SKU · motivo`). */
  importReportText(): string {
    const rep = this.importReport;
    if (!rep) return '';
    const head = `total=${rep.total} created=${rep.created} skipped=${rep.skipped} failed=${rep.failed.length}`;
    const lines = rep.failed.map((f) => `línea ${f.line} · ${f.sku || '—'} · ${f.reason}`);
    return [head, ...lines].join('\n');
  }

  // Modal de resolución de categorías del importador (ADR-0085): una fila por texto sin resolver,
  // con elegir categoría existente / crear nueva / omitir; al confirmar persiste el alias.
  private renderImportModal() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    const setChoice = (text: string, patch: Partial<(typeof this.importChoice)[string]>) => {
      this.importChoice = { ...this.importChoice, [text]: { ...this.importChoice[text], ...patch } };
    };
    return html`
      <ion-modal .isOpen=${this.importOpen} @ionModalDidDismiss=${() => (this.importOpen = false)}>
        <ion-header>
          <ion-toolbar>
            <ion-title>${t('ui.importTaxTitle')}</ion-title>
            <ion-buttons slot="end">
              <ion-button data-testid="inventory-products-import-tax-close" @click=${() => (this.importOpen = false)}>${t('ui.btnCancel')}</ion-button>
            </ion-buttons>
          </ion-toolbar>
        </ion-header>
        <ion-content class="ion-padding">
          <p>${t('ui.importTaxHint')}</p>
          ${this.importUnresolved.map((text) => {
            const c = this.importChoice[text] ?? { mode: 'pick', key: '', newKey: '', newName: text };
            return html`<div style="border:1px solid var(--ion-border-color,#e6e2d8);border-radius:10px;padding:.6rem .8rem;margin-bottom:.7rem;">
              <!-- La cadena vacía no es un texto del CSV: es el cajón de las filas que no traen
                   columna fiscal (inventory#38). Pintarla entre comillas no diría nada. -->
              <strong>${text === '' ? t('ui.importTaxMissingLabel') : `"${text}"`}</strong>
              <ion-segment data-testid=${`inventory-products-import-tax-mode-${text}`} .value=${c.mode} @ionChange=${(e: any) => setChoice(text, { mode: e.detail.value })} style="margin:.5rem 0;">
                <ion-segment-button data-testid=${`inventory-products-import-tax-pick-${text}`} value="pick"><ion-label>${t('ui.importPick')}</ion-label></ion-segment-button>
                <ion-segment-button data-testid=${`inventory-products-import-tax-create-${text}`} value="create"><ion-label>${t('ui.importCreate')}</ion-label></ion-segment-button>
                <ion-segment-button data-testid=${`inventory-products-import-tax-skip-${text}`} value="skip"><ion-label>${t('ui.importSkip')}</ion-label></ion-segment-button>
              </ion-segment>
              ${c.mode === 'pick'
                ? html`<ion-select mode="md" data-testid=${`inventory-products-import-tax-category-${text}`} fill="outline" label-placement="floating" label=${t('ui.colCategory')} .value=${c.key} @ionChange=${(e: any) => setChoice(text, { key: e.detail.value })}>
                    ${this.taxCategories.map((cat) => html`<ion-select-option .value=${cat.key}>${taxCategoryOptionLabel(cat, this.taxRates, t)}</ion-select-option>`)}
                  </ion-select>`
                : nothing}
              ${c.mode === 'create'
                ? html`<div style="display:flex;gap:.5rem;flex-wrap:wrap;">
                    <ion-input mode="md" data-testid=${`inventory-products-import-tax-new-key-${text}`} fill="outline" label-placement="floating" label=${t('ui.colKey')} placeholder="restaurant.food" .value=${c.newKey} @ionInput=${(e: any) => setChoice(text, { newKey: e.target.value })}></ion-input>
                    <ion-input mode="md" data-testid=${`inventory-products-import-tax-new-name-${text}`} fill="outline" label-placement="floating" label=${t('ui.colName')} .value=${c.newName} @ionInput=${(e: any) => setChoice(text, { newName: e.target.value })}></ion-input>
                  </div>`
                : nothing}
            </div>`;
          })}
          <ion-button data-testid="inventory-products-import-tax-submit" expand="block" @click=${() => this.confirmImportResolution()}>${t('ui.importConfirm')}</ion-button>
        </ion-content>
      </ion-modal>
    `;
  }

  // Código de barras Code128 (SVG) del SKU. Barras NEGRAS fijas y `max-width` INLINE
  // (inventory#45): un código de barras no se tematiza —el escáner necesita oscuro sobre claro— y
  // las reglas del shadow no llegan al modal, que Ionic reparenta a <body>.
  private renderBarcode(text: string) {
    const bc = code128b(text, 2, 70);
    return html`<svg
      class="bc"
      style="max-width:100%; height:auto; background:#fff;"
      width=${bc.width}
      height=${bc.height}
      viewBox="0 0 ${bc.width} ${bc.height}"
      fill="#000"
    >
      ${bc.bars.map((b) => svg`<rect x=${b.x} y="0" width=${b.w} height=${bc.height}></rect>`)}
    </svg>`;
  }
  // Prints the barcode label through the SINGLE print gate (issue #30, ADR-0196 decision 5):
  // `erplora.print` (Bridge/label printer first) → isolated iframe. The old `window.open` popup
  // with an inline `window.print()` script bypassed the gate; contract in barcode-print.test.ts.
  //
  // The outcome is READ and SHOWN (inventory#44): the gate can cross fine and still print nothing
  // (no printer holding the `label` role, a refused document, the webview's dialog-less fallback),
  // and the old `void` turned every one of those into a button that did nothing without a word.
  private async printBarcode(p: Product): Promise<void> {
    this.printError = '';
    const t = (k: string): string => erplora().t(CATALOG, k);
    const out = await printBarcodeLabel({ sku: p.sku, name: p.name, priceCents: Number(p.price) });
    if (out.ok) return;
    const head = out.reason === 'no_printer' ? t('ui.errPrintBarcodeNoPrinter') : t('ui.errPrintBarcode');
    this.printError = out.detail ? `${head} (${out.detail})` : head;
  }

  // Init una sola vez tras el primer render (equivalente a `componentWillLoad` de Stencil: el shell
  // crea una instancia nueva del WC en cada montaje de la vista). El re-render lo dispara el
  // controlador vía `requestUpdate()` (sustituye al antiguo `this.tick++`), no un @state.
  // Re-render al cambiar el idioma del shell (ADR-0055): los getters `columns`/`actions` y el
  // texto del template se re-evalúan con el nuevo `erplora.locale`.
  private readonly onLocaleChange = (): void => this.requestUpdate();
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
  }

  async firstUpdated(): Promise<void> {
    // Wired natively, not with a Lit `@click` on the tag: `<ok-data-table>` carries `testid`, not
    // `data-testid` (outfitkit#143), and a template binding would read as an action element.
    this.renderRoot.querySelector('ok-data-table')?.addEventListener('click', (e) => this.onTableClick(e));
    // inventory#72 — the POS links here from its «N articles cannot be sold» warning, and it links
    // to the list ALREADY narrowed. The filter is seeded into the controller instead of applied
    // after the first load on purpose: applying it later would fetch the 280 rows first and let
    // them flash on screen before shrinking to twelve.
    const status = statusFilterFromSearch(window.location.search);
    const filters: Record<string, unknown> = {};
    if (status === STATUS_UNCONFIGURED) filters.needs_tax_setup = '1';
    else if (status !== '') filters.is_active = status;
    // …y el desplegable de la tabla arranca enseñándolo (inventory#83): sin esto la lista sale
    // acotada con el control en blanco, que es exactamente lo que el aviso manual de #72 parcheaba.
    if (status !== '') this.tableFilters = { is_active: status };
    this.ctrl = createListController<Product>(
      erplora(),
      'inventory.products.list',
      () => this.requestUpdate(),
      { pageSize: 50, sort: 'name', dir: 'asc', filters },
    );
    await this.ctrl.load();
    void this.loadTaxCategories();
    void this.loadProductCategories();
    void this.loadUnits();
    void this.loadStockSettings();
    // Reactividad: al cambiar stock o crearse un producto, recargamos la página actual.
    try {
      const reload = () => this.ctrl.load();
      const off1 = erplora().on('inventory.stock_changed', reload);
      const off2 = erplora().on('inventory.product.created', reload);
      this.unsub = () => {
        off1();
        off2();
      };
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback(): void {
    window.removeEventListener('erplora:locale-changed', this.onLocaleChange);
    super.disconnectedCallback();
    this.unsub?.();
  }

  // Carga las CATEGORÍAS fiscales para el selector del formulario (ADR-0085). Que la query falle
  // (sin permiso, `taxes` degradado…) NO puede tumbar la página, pero desde inventory#38 tampoco
  // deja pasar el alta: sin catálogo no hay categoría que elegir, y el formulario lo dice en vez de
  // guardar un producto que nadie podrá cobrar. El % lo resuelve `taxes` por país+categoría.
  private async loadTaxCategories(): Promise<void> {
    try {
      // Ordenado por `display_name`, que es lo que se LEE en el desplegable: ordenar por `name`
      // dejaba la lista alfabetizada en inglés y pintada en español (inventory#64). `taxes` admite
      // esa columna en su whitelist de `sort`; si algún día no la admitiera, la query falla y el
      // catch de abajo deja el catálogo vacío — que es la misma degradación de siempre.
      const res = await erplora().queryAll<TaxCategory>('taxes.categories.list', { sort: 'display_name', dir: 'asc' });
      // `Array.isArray`, no `?? []`: si esto NO es una lista, `.map()` peta EN EL RENDER y se lleva
      // por delante la página de productos entera — por un desplegable de IVA. El alta de productos
      // no puede depender de que `taxes` conteste bien.
      this.taxCategories = Array.isArray(res) ? res : [];
    } catch {
      this.taxCategories = [];
    }
    // El TIPO aplicable (inventory#58). Va después y por separado a propósito: que `taxes` no sepa
    // decir el % no puede dejar sin categorías el desplegable — son dos lecturas independientes.
    this.taxRates = await loadTaxRates(erplora());
  }

  // Opciones del ion-select: una categoría por fila, etiqueta «Nombre · 21 %» (inventory#58) — SIN
  // la clave técnica, que no es información para quien da de alta un artículo, y CON el tipo
  // aplicable, que es el dato por el que se elige. SIN opción vacía (inventory#38): "— (por
  // defecto)" era la puerta trasera por la que entraba un producto que no sabía cómo tributa. El
  // hueco lo cubre el `placeholder` del select, que no es elegible.
  //
  // NO se preselecciona ninguna (lo que la issue dejaba «a considerar»): elegir por el usuario la
  // categoría «más común» es reponer ese mismo defecto por otra puerta — el producto saldría
  // tributando por omisión y nadie lo habría decidido. Que el campo esté vacío y sea obligatorio es
  // la decisión de inventory#38 y sigue vigente.
  private taxOptions() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return this.taxCategories.map(
      (c) => html`<ion-select-option .value=${c.key}>${taxCategoryOptionLabel(c, this.taxRates, t)}</ion-select-option>`,
    );
  }

  // Registro de unidades (ADR-0147) para el selector de la ficha. Best-effort como el de
  // categorías fiscales: si la query falla, el select se queda con 'ud' y el alta sigue.
  private async loadUnits(): Promise<void> {
    try {
      const rows = await erplora().queryAll<Unit>('inventory.units.list');
      this.units = Array.isArray(rows) ? rows : [];
    } catch {
      this.units = [];
    }
  }

  /** Hub default for stock control (inventory#48). Best-effort: without permission or a settings
   *  row the schema default (tracking on) stands — the server resolves the truth anyway. */
  private async loadStockSettings(): Promise<void> {
    try {
      const rows = await erplora().query<{ track_stock?: number | string }[]>('inventory.settings.get');
      const row = Array.isArray(rows) ? rows[0] : undefined;
      this.hubTracksStock = row?.track_stock == null ? true : Number(row.track_stock) !== 0;
    } catch {
      this.hubTracksStock = true;
    }
  }

  /** What the checkbox shows: the item's own choice, or the hub default when it has none. */
  trackStockEffective(): boolean {
    return this.newTrackStock == null ? this.hubTracksStock : this.newTrackStock === 1;
  }

  /** Touching the checkbox makes the choice EXPLICIT (1/0); only "never touched" stays null. */
  setTrackStock(on: boolean): void {
    this.newTrackStock = on ? 1 : 0;
  }

  /** Effective flag of a LIST row (raw 1/0/null + hub default); services never track. */
  private rowTracksStock(row: Record<string, unknown>): boolean {
    if (row.product_type === 'service') return false;
    const raw = row.track_stock;
    return raw == null || raw === '' ? this.hubTracksStock : Number(raw) !== 0;
  }

  /** Incremento exacto de la unidad. Sin catálogo, `ud` conserva su rejilla natural de 1. */
  private unitIncrement(code: string | undefined): number {
    const normalized = code || 'ud';
    const configured = this.units.find((unit) => unit.code === normalized)?.increment_value;
    return Number(configured ?? (normalized === 'ud' ? 1_000_000 : 0));
  }

  private quantityMatchesUnit(raw: number, unitCode: string | undefined): boolean {
    return onGrid(raw, this.unitIncrement(unitCode));
  }

  private quantityStep(unitCode: string | undefined): string {
    const increment = this.unitIncrement(unitCode);
    return increment > 0 ? formatQuantity(increment) : '0.000001';
  }

  /** Los filtros de la tabla también son entrada humana; el servidor espera los extremos en µ. */
  private stockFilterValue(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) return value;
    const scaled: Record<string, unknown> = {};
    for (const [edge, logical] of Object.entries(value as Record<string, unknown>)) {
      if (logical === '' || logical == null) scaled[edge] = logical;
      else scaled[edge] = parseQuantity(String(logical)) ?? logical;
    }
    return scaled;
  }

  /** Etiqueta del selector: «Kilogramo (kg)» / «Kilogram (kg)» según locale (ADR-0055). */
  unitLabel(u: Unit): string {
    const es = (erplora().locale ?? '').startsWith('es');
    return `${(es && u.name_es) || u.name} (${u.code})`;
  }

  // Opciones del ion-select de unidad. Sin registro cargado (query fallida) queda al menos la
  // unidad suelta, que es el default del contrato.
  private unitOptions() {
    const list: Unit[] = this.units.length
      ? this.units
      : [{ id: '', code: 'ud', name: 'Unit', name_es: 'Unidad' }];
    return list.map((u) => html`<ion-select-option .value=${u.code}>${this.unitLabel(u)}</ion-select-option>`);
  }

  /** Categorías de producto del hub (para el multi-select de la ficha, inventory#8). */
  private async loadProductCategories(): Promise<void> {
    try {
      const rows = await erplora().queryAll<{ id: string; name: string }>('inventory.categories.list');
      this.productCategories = Array.isArray(rows) ? rows : [];
    } catch {
      this.productCategories = [];
    }
  }

  /** Resets every form field to its clean ALTA state (inventory#8): shared by `cancelEdit()` and
   *  the table's «Add» (pm#450), which must reset the form WITHOUT closing the panel it just
   *  opened. Bumping `editSeq` first also discards any edit opening still loading (pm#459): its
   *  reply will find itself no longer the last one and stop instead of overwriting this reset. */
  private resetForm(): void {
    this.editSeq++;
    this.editingId = null;
    this.newName = '';
    this.newSku = '';
    this.newPrice = '';
    this.newCost = '';
    this.newStock = '';
    this.newThreshold = '';
    this.newEan = '';
    this.newDescription = '';
    this.newType = 'physical';
    this.newActive = true;
    this.newTrackStock = null;
    this.newUnitCode = 'ud';
    this.newTaxCategoryKey = '';
    this.initialCategoryIds = new Set();
    this.selectedCategoryIds = new Set();
    this.formError = '';
  }

  /** Back to a clean CREATE form (inventory#8): after an edit, the next «+» inherits nothing.
   *  Also CLOSES the side panel (QA 07-16: it stayed open with an empty form). */
  cancelEdit(): void {
    this.dataTable()?.close();
    this.resetForm();
  }

  /** pm#450: the table's «Add» emits no event and keeps our form state; after an edit it would
   *  show the edited record under a «New» header, and the submit would UPDATE it. Resets the form
   *  without closing: «Add» itself just opened the create panel.
   *
   *  pm#459: «Add» while an edit is still LOADING (`editingId` still null) only discards that
   *  pending opening; a draft typed in the create form survives. */
  private onTableClick(e: Event): void {
    const addId = 'inventory-products-table-add';
    const isAdd = e.composedPath().some((n) => n instanceof HTMLElement && n.dataset.testid === addId);
    if (!isAdd) return;
    if (this.editingId) this.resetForm();
    else this.editSeq++;
  }

  // Submit del form (alta O edición — decide `editingId`, inventory#8). El nombre se
  // conserva por compatibilidad con el template/tests históricos.
  async createProduct(ev: Event): Promise<void> {
    ev.preventDefault();
    const requiredPermission = this.editingId
      ? 'inventory.change_product'
      : 'inventory.add_product';
    if (!can(requiredPermission) || !this.newName.trim() || !this.newSku.trim()) return;
    const t = (k: string): string => erplora().t(CATALOG, k);
    // Categoría fiscal OBLIGATORIA (inventory#38), y explicada: el botón deshabilitado ya lo
    // impide, pero un botón muerto no dice POR QUÉ. También cubre la edición: un producto
    // configurado no se puede des-configurar vaciando el selector.
    if (!this.newTaxCategoryKey) {
      this.formError = t('ui.errTaxCategoryRequired');
      return;
    }
    this.saving = true;
    this.formError = '';
    try {
      const threshold = this.newThreshold.trim() === ''
        ? 10_000_000
        : parseQuantity(this.newThreshold);
      if (threshold === null) throw new Error(t('ui.errQuantity'));
      if (!this.quantityMatchesUnit(threshold, this.newUnitCode)) {
        throw new Error(t('ui.errQuantityGrid'));
      }
      if (this.editingId) {
        // EDICIÓN real: update conservando la identidad (el stock NO se edita aquí —
        // es autoridad del ledger #7: recuento/recepción).
        await erplora().command('inventory.products.update', {
          product_id: this.editingId,
          name: this.newName.trim(),
          price: majorToMinor(this.newPrice),
          cost: majorToMinor(this.newCost),
          low_stock_threshold: threshold,
          ean13: this.newEan.trim() || null,
          description: this.newDescription,
          tax_category_key: this.newTaxCategoryKey,
          is_active: this.newActive ? 1 : 0,
          // Se envía SIEMPRE (no solo si cambió): el comando hace COALESCE y reenviar la
          // actual es idempotente; omitirla también sería válido (se conservaría).
          unit_code: this.newUnitCode,
          // inventory#48: null = keep following the hub (COALESCE keeps the stored value).
          track_stock: this.newTrackStock,
        });
        // Sincroniza el M2M por diferencias (solo lo que cambió).
        for (const cid of this.selectedCategoryIds) {
          if (!this.initialCategoryIds.has(cid)) {
            await erplora().command('inventory.products.add_category', {
              product_id: this.editingId, category_id: cid,
            });
          }
        }
        for (const cid of this.initialCategoryIds) {
          if (!this.selectedCategoryIds.has(cid)) {
            await erplora().command('inventory.products.remove_category', {
              product_id: this.editingId, category_id: cid,
            });
          }
        }
      } else {
        const stock = this.newStock.trim() === '' ? 0 : parseQuantity(this.newStock);
        if (stock === null) throw new Error(t('ui.errQuantity'));
        if (!this.quantityMatchesUnit(stock, this.newUnitCode)) {
          throw new Error(t('ui.errQuantityGrid'));
        }
        // CREATE. The input is in MAJOR units of the hub currency; the column is INTEGER minor
        // units (ADR-0007/0123). Without this boundary, typing «2,20» stored 2 cents.
        await erplora().command('inventory.products.create', {
          name: this.newName.trim(),
          sku: this.newSku.trim(),
          price: majorToMinor(this.newPrice),
          cost: majorToMinor(this.newCost),
          stock,
          low_stock_threshold: threshold,
          product_type: this.newType,
          ean13: this.newEan.trim() || null,
          description: this.newDescription,
          tax_category_key: this.newTaxCategoryKey,
          unit_code: this.newUnitCode,
          image: '',
          // inventory#48: null = follows the hub setting; 1/0 only when the user decided.
          track_stock: this.newTrackStock,
        });
      }
      this.cancelEdit();
      this.dataTable()?.close(); // cierra el panel lateral tras guardar
      await this.ctrl.load(); // refresco inmediato (además del evento)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Errores de unicidad explicados JUNTO al campo (inventory#8), no genéricos.
      if (/unique|duplicate/i.test(msg) && /sku/i.test(msg)) {
        this.formError = t('ui.errSkuTaken');
      } else if (/unique|duplicate/i.test(msg) && /ean/i.test(msg)) {
        this.formError = t('ui.errEanTaken');
      } else {
        this.formError = msg || t('ui.errSaveProduct');
      }
    } finally {
      this.saving = false;
    }
  }

  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`
      <div class="page">
        ${this.formError ? html`<ok-inline-feedback data-testid="inventory-products-form-error" tone="danger" icon="alert-circle-outline">${this.formError}</ok-inline-feedback>` : nothing}
        ${this.ctrl?.error ? html`<ok-inline-feedback data-testid="inventory-products-load-error" tone="danger" icon="alert-circle-outline">${this.ctrl.error}</ok-inline-feedback>` : nothing}
        <!-- Importación en marcha (inventory#13): por dónde va y una salida. Con 280 filas, lo
             único que había era una pantalla quieta durante minutos. -->
        ${this.importProgress
          ? html`<ok-inline-feedback data-testid="inventory-products-import-progress" tone="info" icon="cloud-upload-outline">
              ${erplora().t(CATALOG, 'ui.importProgress', { done: this.importProgress.done, total: this.importProgress.total })}
              <ion-progress-bar .value=${this.importProgress.total ? this.importProgress.done / this.importProgress.total : 0}></ion-progress-bar>
              <ion-button data-testid="inventory-products-import-stop" size="small" fill="clear" @click=${() => this.cancelImport()}>${erplora().t(CATALOG, 'ui.importStop')}</ion-button>
            </ok-inline-feedback>`
          : nothing}

        <!-- The «detail» button is not the only door: rowClickable makes the whole row open the
             same detail modal (outfitkit#67 — the actions column can be off-screen at 1440 px). -->
        <ok-data-table
          testid="inventory-products-table"
          .serverSide=${true}
          .filterValues=${this.tableFilters}
          .fill=${true}
          .labels=${dataTableLabels(erplora().locale)}
          .columns=${this.columns}
          .actions=${this.actions}
          .rowClickable=${true}
          .addable=${can('inventory.add_product')}
          .views=${true}
          .cardTitle=${(row: Record<string, unknown>) => String(row.name ?? row.sku ?? '')}
          .columnPicker=${true}
          .importable=${can('inventory.import_product') && can('inventory.add_product')}
          .exportable=${can('inventory.export_product')}
          .csvName=${'inventory-products.csv'}
          @csvImport=${(e: CustomEvent<{ rows: Record<string, string>[] }>) => this.onCsvImport(e)}
          @rowAction=${(e: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) => this.onRowAction(e)}
          @rowClick=${(e: CustomEvent<{ row: Record<string, unknown> }>) => this.onRowAction({ detail: { actionId: 'detail', row: e.detail.row } } as CustomEvent<{ actionId: string; row: Record<string, unknown> }>)}
          .rows=${this.ctrl?.rows ?? []}
          .total=${this.ctrl?.total ?? 0}
          .page=${this.ctrl?.state.page ?? 0}
          .pageSize=${this.ctrl?.state.pageSize ?? 50}
          .sort=${this.ctrl?.state.sort}
          .sortDir=${this.ctrl?.state.dir ?? 'asc'}
          .searchable=${true}
          .searchPlaceholder=${erplora().t(CATALOG, 'ui.searchProduct')}
          .emptyMessage=${this.ctrl?.loading ? erplora().t(CATALOG, 'ui.loading') : erplora().t(CATALOG, 'ui.noProducts')}
          @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)}
          @pageSizeChange=${(e: CustomEvent<number>) => this.ctrl.setPageSize(e.detail)}
          @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) =>
            this.ctrl.setSort(e.detail.sort, e.detail.dir)}
          @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)}
          @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => {
            // La columna de estado tiene TRES valores repartidos en DOS columnas del servidor
            // (inventory#38): su filtro no es un `setFilter` directo.
            if (e.detail.col === 'is_active') return this.applyStatusFilter(e.detail.value);
            // El valor VISIBLE se anota tal cual llega (inventory#83); al servidor va traducido —
            // `stock` viaja como rango en la unidad del artículo, no como lo teclea el usuario.
            this.setTableFilter(e.detail.col, e.detail.value);
            this.ctrl.setFilter(
              e.detail.col,
              e.detail.col === 'stock' ? this.stockFilterValue(e.detail.value) : e.detail.value,
            );
          }}
        >
          <!-- Formulario de alta: el botón "+" del data-table despliega este acordeón. -->
          <form slot="create" class="form" data-testid="inventory-products-form" @submit=${(e: Event) => this.createProduct(e)}>
            ${this.editingId
              ? html`<div class="drow" style="align-items:center;">
                  ${this.editTitleInHeader
                    ? nothing
                    : html`<b data-testid="inventory-products-editing">${erplora().t(CATALOG, 'ui.editingTitle')} — ${this.newName}</b>`}
                  <ion-button data-testid="inventory-products-edit-cancel" size="small" fill="clear" @click=${() => this.cancelEdit()}>
                    ${erplora().t(CATALOG, 'ui.editingCancel')}
                  </ion-button>
                </div>`
              : nothing}
            <ion-input mode="md"
              data-testid="inventory-products-name"
              fill="outline"
              label=${erplora().t(CATALOG, 'ui.name')}
              label-placement="floating"
              .value=${this.newName}
              @ionInput=${(e: Event) => (this.newName = (e.target as HTMLInputElement).value)}
            ></ion-input>
            <ion-input mode="md"
              data-testid="inventory-products-sku"
              fill="outline"
              label="SKU"
              label-placement="floating"
              .value=${this.newSku}
              .disabled=${!!this.editingId}
              helper-text=${this.editingId ? erplora().t(CATALOG, 'ui.skuIdentity') : ''}
              @ionInput=${(e: Event) => (this.newSku = (e.target as HTMLInputElement).value)}
            ></ion-input>
            <ion-input mode="md"
              data-testid="inventory-products-price"
              fill="outline"
              label=${erplora().t(CATALOG, 'ui.price')}
              label-placement="floating"
              type="number"
              .step=${moneyStep()}
              .value=${this.newPrice}
              @ionInput=${(e: Event) => (this.newPrice = (e.target as HTMLInputElement).value)}
            ></ion-input>
            <ion-input mode="md"
              data-testid="inventory-products-cost"
              fill="outline"
              label=${`${erplora().t(CATALOG, 'ui.fieldCost')} (${erplora().currency})`}
              label-placement="floating"
              type="number" .step=${moneyStep()} min="0"
              .value=${this.newCost}
              @ionInput=${(e: Event) => (this.newCost = (e.target as HTMLInputElement).value)}
            ></ion-input>
            ${!this.editingId
              ? html`<ion-input mode="md"
                  data-testid="inventory-products-initial-stock"
                  fill="outline"
                  label=${erplora().t(CATALOG, 'ui.fieldInitialStock')}
                  label-placement="floating"
                  type="number" .step=${this.quantityStep(this.newUnitCode)} min="0"
                  .value=${this.newStock}
                  @ionInput=${(e: Event) => (this.newStock = (e.target as HTMLInputElement).value)}
                ></ion-input>`
              : nothing}
            <ion-input mode="md"
              data-testid="inventory-products-threshold"
              fill="outline"
              label=${erplora().t(CATALOG, 'ui.fieldThreshold')}
              label-placement="floating"
              type="number" .step=${this.quantityStep(this.newUnitCode)} min="0"
              .value=${this.newThreshold}
              @ionInput=${(e: Event) => (this.newThreshold = (e.target as HTMLInputElement).value)}
            ></ion-input>
            <ion-input mode="md"
              data-testid="inventory-products-ean13"
              fill="outline"
              label="EAN-13"
              label-placement="floating"
              maxlength="13"
              .value=${this.newEan}
              @ionInput=${(e: Event) => (this.newEan = (e.target as HTMLInputElement).value)}
            ></ion-input>
            <ion-input mode="md"
              data-testid="inventory-products-description"
              fill="outline"
              label=${erplora().t(CATALOG, 'ui.fieldDescription')}
              label-placement="floating"
              .value=${this.newDescription}
              @ionInput=${(e: Event) => (this.newDescription = (e.target as HTMLInputElement).value)}
            ></ion-input>
            ${!this.editingId
              ? html`<ion-select mode="md"
                  data-testid="inventory-products-type"
                  fill="outline"
                  label-placement="floating"
                  label=${erplora().t(CATALOG, 'ui.fieldType')}
                  .value=${this.newType}
                  @ionChange=${(e: Event) => (this.newType = ((e.target as HTMLInputElement).value === 'service' ? 'service' : 'physical'))}
                >
                  <ion-select-option value="physical">${erplora().t(CATALOG, 'ui.typePhysical')}</ion-select-option>
                  <ion-select-option value="service">${erplora().t(CATALOG, 'ui.typeService')}</ion-select-option>
                </ion-select>`
              : nothing}
            ${this.newType !== 'service'
              ? html`<!-- Stock control PER ITEM (inventory#48): the market's checkbox
                          (Square «Track stock», Odoo «Track Inventory», Shopify «Track quantity»).
                          Shows the EFFECTIVE value; touching it makes the choice explicit. -->
                  <ion-checkbox
                    data-testid="inventory-products-track-stock"
                    label-placement="end"
                    justify="start"
                    .checked=${this.trackStockEffective()}
                    @ionChange=${(e: CustomEvent) => this.setTrackStock(!!(e.detail as { checked?: boolean }).checked)}
                  >${erplora().t(CATALOG, 'ui.fieldTrackStock')}</ion-checkbox>
                  <ion-note class="track-note">
                    ${this.newTrackStock == null
                      ? erplora().t(CATALOG, 'ui.trackStockInherit')
                      : this.newTrackStock === 0
                        ? erplora().t(CATALOG, 'ui.trackStockOff')
                        : nothing}
                  </ion-note>`
              : nothing}
            <ion-select mode="md"
              data-testid="inventory-products-unit"
              fill="outline"
              label-placement="floating"
              interface="popover"
              label=${erplora().t(CATALOG, 'ui.fieldUnit')}
              .value=${this.newUnitCode}
              @ionChange=${(e: Event) => (this.newUnitCode = (e.target as HTMLInputElement).value || 'ud')}
            >
              ${this.unitOptions()}
            </ion-select>
            <!-- Categoría fiscal: campo OBLIGATORIO (inventory#38), no un asterisco decorativo.
                 Sin catálogo de categorías no hay nada que elegir, así que se dice en vez de
                 dejar guardar un producto que después nadie puede cobrar. -->
            <ion-select mode="md"
              data-testid="inventory-products-tax-category"
              fill="outline"
              label-placement="floating"
              required
              label=${erplora().t(CATALOG, 'ui.fieldTaxCategory')}
              placeholder=${erplora().t(CATALOG, 'ui.taxCategoryPlaceholder')}
              .value=${this.newTaxCategoryKey}
              @ionChange=${(e: Event) => (this.newTaxCategoryKey = (e.target as HTMLInputElement).value)}
            >
              ${this.taxOptions()}
            </ion-select>
            ${this.taxCategories.length === 0
              ? html`<ok-inline-feedback data-testid="inventory-products-tax-none" tone="warning" icon="alert-circle-outline">
                  ${erplora().t(CATALOG, 'ui.taxNoneAvailable')}
                </ok-inline-feedback>`
              : nothing}
            ${this.productCategories.length
              ? html`<ion-select mode="md"
                  data-testid="inventory-products-categories"
                  fill="outline"
                  label-placement="floating"
                  label=${erplora().t(CATALOG, 'ui.fieldCategories')}
                  .multiple=${true}
                  .value=${[...this.selectedCategoryIds]}
                  @ionChange=${(e: CustomEvent) => {
                    const v = (e.detail as { value?: string[] }).value ?? [];
                    this.selectedCategoryIds = new Set(v);
                  }}
                >
                  ${this.productCategories.map(
                    (c) => html`<ion-select-option .value=${c.id}>${c.name}</ion-select-option>`,
                  )}
                </ion-select>`
              : nothing}
            <ion-button data-testid="inventory-products-submit" type="submit" ?disabled=${this.saving || !this.newName || !this.newSku || !this.newTaxCategoryKey}>
              ${this.saving
                ? erplora().t(CATALOG, 'ui.saving')
                : this.editingId
                  ? erplora().t(CATALOG, 'ui.saveChanges')
                  : erplora().t(CATALOG, 'ui.save')}
            </ion-button>
          </form>
        </ok-data-table>

        <ion-modal
          .isOpen=${!!this.detail}
          @ionModalDidDismiss=${() => {
            this.detail = null;
            this.printError = '';
          }}
        >
          <ion-header class="ion-no-border">
            <ion-toolbar>
              <ion-title>${this.detail?.name ?? ''}</ion-title>
              <ion-buttons slot="end">
                <ion-button data-testid="inventory-products-detail-close" aria-label=${erplora().t(CATALOG, 'ui.btnClose')} @click=${() => { this.detail = null; this.printError = ''; }}><ion-icon name="close" slot="icon-only"></ion-icon></ion-button>
              </ion-buttons>
            </ion-toolbar>
          </ion-header>
          <ion-content class="ion-padding">
            ${this.detail
              ? html`
                  <!-- Auto-estilado (reparent a <body>): las clases .detail/.drow/.barcode del
                       shadow NO llegan aquí — Ionic puro + estilos inline para el barcode. -->
                  <ion-list lines="full">
                    <ion-item>
                      <ion-label>SKU</ion-label>
                      <ion-note slot="end">${this.detail.sku}</ion-note>
                    </ion-item>
                    <ion-item>
                      <ion-label>${t('ui.price')}</ion-label>
                      <ion-note slot="end">${erplora().formatMoney(Number(this.detail.price))}</ion-note>
                    </ion-item>
                    <ion-item>
                      <ion-label>${t('ui.stock')}</ion-label>
                      <ion-note slot="end">${formatQuantity(this.detail.stock)}</ion-note>
                    </ion-item>
                    <ion-item>
                      <ion-label>${t('ui.status')}</ion-label>
                      <ion-note
                        slot="end"
                        style=${ionTone('text', this.productStatus(this.detail as unknown as Record<string, unknown>).id === 'unconfigured' ? 'warning' : 'medium')}
                      >
                        ${this.productStatus(this.detail as unknown as Record<string, unknown>).label}
                        ${this.productStatus(this.detail as unknown as Record<string, unknown>).reason}
                      </ion-note>
                    </ion-item>
                  </ion-list>
                  <!-- Placa BLANCA con barras negras SIEMPRE, en los dos temas (inventory#45): sin
                       fondo propio heredaba el del modal (oscuro) y quedaba negro sobre negro,
                       ilegible para cualquier escáner. Inline porque el modal está reparentado. -->
                  <div style="text-align:center; margin:1rem 0; padding:1rem; border:1px solid #d7d2c8; border-radius:10px; background:#fff; color:#000;">
                    ${this.renderBarcode(this.detail.sku)}
                    <div style="font:14px ui-monospace,monospace; margin-top:.4rem; letter-spacing:.08em; color:#000;">${this.detail.sku}</div>
                  </div>
                  ${this.printError
                    ? html`<ok-inline-feedback data-testid="inventory-products-print-error" tone="danger" icon="alert-circle-outline">${this.printError}</ok-inline-feedback>`
                    : nothing}
                  <ion-button data-testid="inventory-products-print-barcode" expand="block" @click=${() => this.detail && void this.printBarcode(this.detail)}>
                    <ion-icon name="print-outline" slot="start"></ion-icon> ${t('ui.printBarcode')}
                  </ion-button>
                `
              : nothing}
          </ion-content>
        </ion-modal>
        ${this.renderDeleteModal()}
        ${this.renderCountModal()}
        ${this.renderReceiveModal()}
        ${this.renderPreviewModal()}
        ${this.renderImportModal()}
        ${this.renderImportReportModal()}
      </div>
    `;
  }

  /**
   * Vista previa del CSV: qué columna es qué, cómo quedan las primeras filas y cuántas están
   * listas — antes de crear NADA (inventory#13).
   *
   * Copiado de donde ya funciona: el desplegable por columna con «no importar» es de WooCommerce y
   * Lightspeed (que además no dejan seguir sin las obligatorias, la regla del botón de abajo); el
   * ensayo que cuenta filas listas y problemas es el «Test import» de Odoo; el resumen antes de
   * confirmar, de Shopify. Nada de esto se ha inventado aquí.
   */
  private renderPreviewModal() {
    // Sin fichero no se pinta NADA, ni siquiera el esqueleto cerrado: el contenido de un
    // `ion-modal` vive en el DOM aunque esté cerrado, y un `ok-inline-feedback` ahí dentro es un
    // aviso que la página tiene sin tenerlo.
    if (!this.previewOpen) return html`<ion-modal .isOpen=${false}></ion-modal>`;
    const t = (k: string, p?: Record<string, unknown>): string => erplora().t(CATALOG, k, p);
    const headers = Object.keys(this.previewRows[0] ?? {});
    const summary = this.previewSummary;
    const fieldLabel: Record<ImportField, string> = {
      name: t('ui.name'), sku: t('ui.sku'), price: t('ui.price'), cost: t('ui.fieldCost'),
      stock: t('ui.stock'), low_stock_threshold: t('ui.fieldThreshold'), ean13: 'EAN-13',
      description: t('ui.fieldDescription'), unit_code: t('ui.fieldUnit'), tax: t('ui.fieldTaxCategory'),
    };
    return html`
      <ion-modal .isOpen=${this.previewOpen} @ionModalDidDismiss=${() => this.cancelPreview()}>
        <ion-header class="ion-no-border">
          <ion-toolbar>
            <ion-title>${t('ui.previewTitle')}</ion-title>
            <ion-buttons slot="end">
              <ion-button data-testid="inventory-products-preview-close" aria-label=${t('ui.btnCancel')} @click=${() => this.cancelPreview()}><ion-icon name="close" slot="icon-only"></ion-icon></ion-button>
            </ion-buttons>
          </ion-toolbar>
        </ion-header>
        <!-- Auto-estilado (el modal se reparenta a <body> y el CSS del shadow no llega): Ionic
             puro + estilos inline. -->
        <ion-content class="ion-padding">
          <p style="margin:0 0 .75rem">${t('ui.previewHint')}</p>
          <ion-list lines="full">
            ${headers.map(
              (h) => html`<ion-item>
                <ion-select
                  data-testid=${`inventory-products-preview-column-${h}`}
                  label=${h}
                  label-placement="stacked"
                  .value=${this.previewMapping[h] ?? ''}
                  @ionChange=${(e: Event) => {
                    const field = (e.target as HTMLInputElement).value as ImportField | '';
                    // Un destino no puede estar en dos columnas: al elegirlo aquí, se suelta allí.
                    const next: Record<string, ImportField | ''> = { ...this.previewMapping };
                    if (field) for (const k of Object.keys(next)) if (next[k] === field) next[k] = '';
                    next[h] = field;
                    this.previewMapping = next;
                  }}
                >
                  <ion-select-option value="">${t('ui.previewIgnore')}</ion-select-option>
                  ${IMPORT_FIELDS.map(
                    (f) => html`<ion-select-option .value=${f}>${fieldLabel[f]}${IMPORT_REQUIRED.includes(f) ? ' *' : ''}</ion-select-option>`,
                  )}
                </ion-select>
              </ion-item>`,
            )}
          </ion-list>

          <h3 style="margin:1rem 0 .35rem; font-size:.95rem">${t('ui.previewRowsTitle', { n: Math.min(PREVIEW_ROWS, this.previewRows.length), total: this.previewRows.length })}</h3>
          <!-- La tabla scrollea SOLA en horizontal: un CSV de 15 columnas no puede empujar el
               modal fuera de la pantalla de una tablet. -->
          <div style="overflow-x:auto; -webkit-overflow-scrolling:touch">
            <table style="border-collapse:collapse; font-size:.85rem; min-width:100%">
              <thead>
                <tr>${headers.map((h) => html`<th style="text-align:left; padding:.3rem .5rem; white-space:nowrap; border-bottom:1px solid var(--ion-color-step-200,#d7d2c8)">${this.previewMapping[h] ? fieldLabel[this.previewMapping[h] as ImportField] : html`<s>${h}</s>`}</th>`)}</tr>
              </thead>
              <tbody>
                ${this.previewRows.slice(0, PREVIEW_ROWS).map(
                  (r) => html`<tr>${headers.map((h) => html`<td style="padding:.3rem .5rem; white-space:nowrap; border-bottom:1px solid var(--ion-color-step-100,#eee)">${r[h] ?? ''}</td>`)}</tr>`,
                )}
              </tbody>
            </table>
          </div>

          ${this.previewReady
            ? html`<ok-inline-feedback
                data-testid="inventory-products-preview-summary"
                class="ion-margin-top"
                tone=${summary.failed.length ? 'warning' : 'success'}
                icon=${summary.failed.length ? 'alert-circle-outline' : 'checkmark-outline'}
              >
                ${t('ui.previewSummary', { ready: summary.ready, failed: summary.failed.length })}
                ${summary.failed.length
                  ? html`<ul style="margin:.3rem 0 0; padding-left:1.1rem">
                      ${summary.failed.slice(0, 10).map((f) => html`<li>${t('ui.importLine')} ${f.line}: ${f.reason}</li>`)}
                    </ul>`
                  : nothing}
              </ok-inline-feedback>`
            : html`<ok-inline-feedback data-testid="inventory-products-preview-missing-required" class="ion-margin-top" tone="danger" icon="alert-circle-outline">
                ${t('ui.previewMissingRequired')}
              </ok-inline-feedback>`}

          <ion-button
            data-testid="inventory-products-preview-submit"
            class="ion-margin-top"
            expand="block"
            ?disabled=${!this.previewReady || summary.ready === 0}
            @click=${() => void this.confirmPreview()}
          >
            ${t('ui.previewConfirm', { n: summary.ready })}
          </ion-button>
          <ion-button data-testid="inventory-products-preview-cancel" expand="block" fill="outline" @click=${() => this.cancelPreview()}>${t('ui.btnCancel')}</ion-button>
        </ion-content>
      </ion-modal>
    `;
  }

  // Informe del import CSV (inventory#13): total/creadas/omitidas/fallidas con línea y
  // motivo, copiable al portapapeles para corregir el fichero y reintentar.
  private renderImportReportModal() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    const rep = this.importReport;
    return html`
      <ion-modal .isOpen=${!!rep} @ionModalDidDismiss=${() => (this.importReport = null)}>
        <ion-header class="ion-no-border">
          <ion-toolbar>
            <ion-title>${t('ui.importReportTitle')}</ion-title>
            <ion-buttons slot="end">
              <ion-button data-testid="inventory-products-import-report-close" aria-label=${t('ui.btnClose')} @click=${() => (this.importReport = null)}><ion-icon name="close" slot="icon-only"></ion-icon></ion-button>
            </ion-buttons>
          </ion-toolbar>
        </ion-header>
        <ion-content class="ion-padding">
          ${rep
            ? html`
                <!-- Auto-estilado (reparent a <body>): Ionic puro, sin clases del shadow. -->
                ${rep.cancelled
                  ? html`<ok-inline-feedback data-testid="inventory-products-import-report-cancelled" tone="warning" icon="alert-circle-outline">${t('ui.importCancelledNote')}</ok-inline-feedback>`
                  : nothing}
                <ion-list lines="full">
                  <ion-item>
                    <ion-label>${t('ui.importTotal')}</ion-label>
                    <ion-note slot="end">${rep.total}</ion-note>
                  </ion-item>
                  <ion-item>
                    <ion-label>${t('ui.importCreated')}</ion-label>
                    <ion-note slot="end" style=${ionTone('text', 'success')}>${rep.created}</ion-note>
                  </ion-item>
                  <ion-item>
                    <ion-label>${t('ui.importSkipped')}</ion-label>
                    <ion-note slot="end">${rep.skipped}</ion-note>
                  </ion-item>
                  <ion-item>
                    <ion-label>${t('ui.importFailed')}</ion-label>
                    <ion-note slot="end" style=${ionTone('text', rep.failed.length ? 'danger' : 'success')}>${rep.failed.length}</ion-note>
                  </ion-item>
                </ion-list>
                ${rep.failed.length
                  ? html`
                      <ion-list class="ion-margin-top" lines="none">
                        ${rep.failed.map(
                          (f) => html`<ion-item>
                            <ion-label class="ion-text-wrap">
                              <b>${t('ui.importLine')} ${f.line}</b> · ${f.sku || '—'} — ${f.reason}
                            </ion-label>
                          </ion-item>`,
                        )}
                      </ion-list>
                      <ion-button data-testid="inventory-products-import-report-copy" class="ion-margin-top" expand="block" fill="outline"
                        @click=${() => navigator.clipboard?.writeText(this.importReportText())}>
                        <ion-icon name="copy-outline" slot="start"></ion-icon>${t('ui.importCopy')}
                      </ion-button>
                    `
                  : nothing}
              `
            : nothing}
        </ion-content>
      </ion-modal>
    `;
  }

  // Confirmación de borrado de producto (P1 QA #6): paridad con el borrado de categorías.
  private renderDeleteModal() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`
      <ion-modal .isOpen=${!!this.deleteTarget} @ionModalDidDismiss=${() => (this.deleteTarget = null)}>
        <ion-header class="ion-no-border">
          <ion-toolbar>
            <ion-title>${t('ui.deleteProdTitle')}</ion-title>
          </ion-toolbar>
        </ion-header>
        <ion-content class="ion-padding">
          <ion-list lines="none">
            <ion-item>
              <ion-label class="ion-text-wrap">
                <b>${this.deleteTarget?.name ?? ''}</b> (${this.deleteTarget?.sku ?? ''}) — ${t('ui.deleteProdHint')}
              </ion-label>
            </ion-item>
          </ion-list>
          <ion-button data-testid="inventory-products-delete-submit" class="ion-margin-top" expand="block" style=${ionTone('solid', 'danger')} @click=${() => this.confirmDelete()}>
            ${t('ui.actionDelete')}
          </ion-button>
          <ion-button data-testid="inventory-products-delete-cancel" expand="block" fill="outline" @click=${() => (this.deleteTarget = null)}>
            ${t('ui.btnCancel')}
          </ion-button>
        </ion-content>
      </ion-modal>
    `;
  }

  // Modal de RECUENTO (inventory#7): ajuste absoluto — se enseña la diferencia contra el
  // stock actual ANTES de aplicar, y el motivo es obligatorio (lo exige también el schema).
  /**
   * Qué le falta al recuento para poder aplicarse, como clave i18n — o `null` si no le falta nada
   * (inventory#59). Se nombra UN solo motivo, el primero que hay que resolver: una lista de todo lo
   * que falta es más texto y menos acción. `null` cuando el botón está activo, para no dejar una
   * nota colgando que ya no explica nada.
   */
  private countBlockedReason(): string | null {
    if (this.countDifference === null) return 'ui.countNeedsQty';
    if (this.countReason.trim() === '') return 'ui.countNeedsReason';
    return null;
  }

  private renderCountModal() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    const diff = this.countDifference;
    return html`
      <ion-modal .isOpen=${!!this.countTarget} @ionModalDidDismiss=${() => (this.countTarget = null)}>
        <ion-header class="ion-no-border">
          <ion-toolbar>
            <ion-title>${t('ui.countTitle')} — ${this.countTarget?.name ?? ''}</ion-title>
            <ion-buttons slot="end">
              <ion-button data-testid="inventory-products-count-close" aria-label=${t('ui.btnClose')} @click=${() => (this.countTarget = null)}><ion-icon name="close" slot="icon-only"></ion-icon></ion-button>
            </ion-buttons>
          </ion-toolbar>
        </ion-header>
        <ion-content class="ion-padding">
          <!-- OJO: ion-modal se re-aparenta a <body> y PIERDE el CSS del shadow del
               componente — el contenido debe AUTO-ESTILARSE (Ionic puro + ion-margin-*),
               nunca clases propias (.detail/.drow). Patrón de la casa (sales-list). -->
          <ion-list lines="full">
            <ion-item>
              <ion-label>${t('ui.countCurrent')}</ion-label>
              <ion-note slot="end">${formatQuantity(this.countTarget?.stock ?? 0)}</ion-note>
            </ion-item>
            ${diff !== null
              ? html`<ion-item>
                  <ion-label>${t('ui.countDiff')}</ion-label>
                  <ion-note slot="end" style=${ionTone('text', diff < 0 ? 'danger' : 'success')}>${diff > 0 ? `+${diff}` : diff}</ion-note>
                </ion-item>`
              : nothing}
          </ion-list>
          <ion-input mode="md" data-testid="inventory-products-count-qty" class="ion-margin-top" fill="outline" label-placement="floating" label=${t('ui.countNew')}
            type="number" .step=${this.quantityStep(this.countTarget?.unit_code)} min="0" inputmode="decimal"
            .value=${this.countValue}
            @ionInput=${(e: CustomEvent) => (this.countValue = String((e.detail as { value?: string }).value ?? ''))}
          ></ion-input>
          <ion-input mode="md" data-testid="inventory-products-count-reason" class="ion-margin-top" fill="outline" label-placement="floating" label=${t('ui.countReason')}
            .value=${this.countReason} required
            @ionInput=${(e: CustomEvent) => (this.countReason = String((e.detail as { value?: string }).value ?? ''))}
          ></ion-input>
          <ion-button data-testid="inventory-products-count-submit" class="ion-margin-top" expand="block" .disabled=${diff === null || this.countReason.trim() === ''}
            @click=${() => this.submitCount()}>
            ${t('ui.countApply')}
          </ion-button>
          <!-- Por qué está en gris (inventory#59). Un botón desactivado sin explicación deja al
               operario mirando el modal sin saber qué le falta; con las cajas ya visibles, esto
               cierra el hueco nombrando el campo que falta en vez de callar. -->
          ${this.countBlockedReason()
            ? html`<ion-note class="ion-margin-top" style=${`display:block;text-align:center;${ionTone('text', 'medium')}`}>
                ${t(this.countBlockedReason() as string)}
              </ion-note>`
            : nothing}
        </ion-content>
      </ion-modal>
    `;
  }

  // Modal de RECEPCIÓN (inventory#7): entrada de mercancía por producto (qty decimal —
  // #10 — y coste unitario en euros → céntimos). El movimiento `reception` lo deja el SQL.
  private renderReceiveModal() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`
      <ion-modal .isOpen=${!!this.receiveTarget} @ionModalDidDismiss=${() => (this.receiveTarget = null)}>
        <ion-header class="ion-no-border">
          <ion-toolbar>
            <ion-title>${t('ui.receiveTitle')} — ${this.receiveTarget?.name ?? ''}</ion-title>
            <ion-buttons slot="end">
              <ion-button data-testid="inventory-products-receive-close" aria-label=${t('ui.btnClose')} @click=${() => (this.receiveTarget = null)}><ion-icon name="close" slot="icon-only"></ion-icon></ion-button>
            </ion-buttons>
          </ion-toolbar>
        </ion-header>
        <ion-content class="ion-padding">
          <!-- Auto-estilado (ver nota del modal de recuento): el reparent a <body> mata el CSS del shadow. -->
          <ion-list lines="full">
            <ion-item>
              <ion-label>${t('ui.countCurrent')}</ion-label>
              <ion-note slot="end">${formatQuantity(this.receiveTarget?.stock ?? 0)}</ion-note>
            </ion-item>
          </ion-list>
          <ion-input mode="md" data-testid="inventory-products-receive-qty" class="ion-margin-top" fill="outline" label-placement="floating" label=${t('ui.receiveQty')}
            type="number" .step=${this.quantityStep(this.receiveTarget?.unit_code)} min="0.000001" inputmode="decimal"
            .value=${this.receiveQty}
            @ionInput=${(e: CustomEvent) => (this.receiveQty = String((e.detail as { value?: string }).value ?? ''))}
          ></ion-input>
          <ion-input mode="md" data-testid="inventory-products-receive-cost" class="ion-margin-top" fill="outline" label-placement="floating" label=${`${t('ui.receiveCost')} (${erplora().currency})`}
            type="number" .step=${moneyStep()} min="0" inputmode="decimal"
            .value=${this.receiveCost}
            @ionInput=${(e: CustomEvent) => (this.receiveCost = String((e.detail as { value?: string }).value ?? ''))}
          ></ion-input>
          <ion-button data-testid="inventory-products-receive-submit" class="ion-margin-top" expand="block" .disabled=${this.receiveQty.trim() === ''}
            @click=${() => this.submitReceive()}>
            ${t('ui.receiveApply')}
          </ion-button>
        </ion-content>
      </ion-modal>
    `;
  }
}

define('erp-inventory-products', ErpInventoryProducts);
