// API pública de `@erplora/module-sdk` — generada por `tsc --emitDeclarationOnly`,
// NO editar a mano. Regenerar: UPDATE_KERNEL_CONTRACT=1 pnpm -F @erplora/module-sdk contract:check
// Contrato del kernel: ADR «El Hub se CIERRA como KERNEL».

// ── index.d.ts ────────────────────────────────────────────────────────────
export { QUANTITY_SCALE, toMicro, fromMicro, parseQuantity, formatQuantity, onGrid, } from './quantity.ts';
export interface EventMeta {
    clientInstance?: string;
}
export interface ErploraTransport {
    query(name: string, params?: Record<string, unknown>): Promise<unknown>;
    command(name: string, payload?: Record<string, unknown>): Promise<unknown>;
    subscribe(event: string, cb: (payload: unknown) => void): () => void;
    subscribeWithMeta?(event: string, cb: (payload: unknown, meta: EventMeta) => void): () => void;
    fetchMediaBlob?(ref: string, opts?: MediaFetchOptions): Promise<Blob | null>;
}
export interface MediaFetchOptions {
    signal?: AbortSignal;
}
export interface CommandOptions {
    resolvesOutcome?: boolean;
}
export interface Notification {
    type: 'success' | 'error' | 'info' | 'warning';
    message: string;
}
export interface FormatMoneyOptions {
    currency?: string;
    locale?: string;
    maximumFractionDigits?: number;
}
export declare function dataTableLabels(locale?: string): Record<string, string>;
export declare function dataTableShowsLoadError(): boolean;
export interface RangeFilter {
    from?: unknown;
    to?: unknown;
}
export interface ListParams {
    limit?: number;
    offset?: number;
    search?: string;
    sort?: string;
    dir?: 'asc' | 'desc';
    filters?: Record<string, unknown>;
    params?: Record<string, unknown>;
}
export interface Page<T = unknown> {
    rows: T[];
    total: number;
    limit: number;
    offset: number;
}
export declare function buildListParams(p: ListParams): Record<string, unknown>;
export type ListPage<T = unknown> = Page<T>;
export interface ListClient {
    queryPage<R = unknown>(name: string, params: ListParams): Promise<Page<R>>;
    readonly currencyDecimals?: number;
}
export interface ListControllerOptions {
    pageSize?: number;
    sort?: string;
    dir?: 'asc' | 'desc';
    filters?: Record<string, unknown>;
    context?: Record<string, unknown>;
    moneyFilters?: readonly string[];
    quantityFilters?: readonly string[];
}
export interface ListControllerState {
    page: number;
    pageSize: number;
    search: string;
    sort?: string;
    dir: 'asc' | 'desc';
    filters: Record<string, unknown>;
    context: Record<string, unknown>;
}
export declare class ListController<T = Record<string, unknown>> {
    private readonly client;
    private readonly queryName;
    private readonly onChange;
    rows: T[];
    total: number;
    loading: boolean;
    error: string;
    readonly state: ListControllerState;
    private seq;
    private readonly moneyFilters;
    private readonly quantityFilters;
    constructor(client: ListClient, queryName: string, onChange?: () => void, opts?: ListControllerOptions);
    private wireFilters;
    get pageCount(): number;
    load(): Promise<void>;
    setPage(page: number): void;
    setSort(sort: string, dir: 'asc' | 'desc'): void;
    setSearch(search: string): void;
    setPageSize(pageSize: number): void;
    setFilter(col: string, value: unknown): void;
    setContext(context: Record<string, unknown>): void;
    reset(): void;
}
export declare function createListController<T = Record<string, unknown>>(client: ListClient, queryName: string, onChange?: () => void, opts?: ListControllerOptions): ListController<T>;
export declare class ErploraError extends Error {
    readonly code: string;
    readonly permission?: string | undefined;
    readonly fields?: readonly string[] | undefined;
    readonly retryAfterSecs?: number | undefined;
    constructor(code: string, message: string, permission?: string | undefined, fields?: readonly string[] | undefined, retryAfterSecs?: number | undefined);
}
export declare const REQUIRES_ELEVATION = "requires_elevation";
export declare const ELEVATION_APPROVE_PATH = "/api/elevation/approve";
export declare const ELEVATION_TOKEN_HEADER = "X-Elevation-Token";
export interface ElevationApproval {
    token: string;
    permission: string;
    approvedBy: string;
    approverName: string;
    expiresInSeconds: number;
}
export interface ElevationAsk {
    command: string;
    payload: Record<string, unknown>;
    permission: string;
    approve(approver: string, pin: string): Promise<ElevationApproval>;
    approveWithBadge(badge: string): Promise<ElevationApproval>;
}
export type ElevationApprover = (ask: ElevationAsk) => Promise<string | null>;
export declare const SERVER_UNAVAILABLE = "server_unavailable";
export declare function commandVerdictMessage(locale?: string): string;
export declare class UnknownOutcomeError extends ErploraError {
    readonly outcomeUnknown = true;
    constructor(message: string, cause: unknown);
}
export interface PlatformFailure {
    code?: string;
    module?: string;
    query?: string;
    field?: string;
    reason?: string;
}
export declare function platformFailureMessage(failure: PlatformFailure, locale?: string): string | null;
export declare const STREAM_READY = "stream.ready";
export declare const STREAM_ERROR = "stream.error";
export interface HttpWsOptions {
    baseUrl?: string;
    push?: 'ws' | 'sse';
    wsUrl?: string;
    sseUrl?: string;
    headers?: () => Record<string, string>;
    fetchImpl?: typeof fetch;
    WebSocketImpl?: typeof WebSocket;
    EventSourceImpl?: typeof EventSource;
    streamCredential?: () => Promise<string | null>;
    onStreamRefused?: (code: string, message: string) => void;
    elevationApprover?: ElevationApprover;
}
export declare class HttpWsTransport implements ErploraTransport {
    private readonly baseUrl;
    private readonly push;
    private readonly wsUrl;
    private readonly sseUrl;
    private readonly headers;
    private readonly fetchImpl;
    private readonly WebSocketImpl?;
    private readonly EventSourceImpl?;
    private readonly streamCredential?;
    private pushRetryMs;
    private readonly onStreamRefused?;
    private readonly elevationApprover?;
    private readonly elevating;
    private ws?;
    private es?;
    private readonly listeners;
    private pushStarted;
    constructor(opts?: HttpWsOptions);
    private post;
    coreRequest(req: CoreRequest, extraHeaders?: Record<string, string>): Promise<unknown>;
    fetchMediaBlob(ref: string, opts?: MediaFetchOptions): Promise<Blob | null>;
    coreBlobRequest(path: string, extraHeaders?: Record<string, string>): Promise<Blob>;
    private send;
    query(name: string, params?: Record<string, unknown>): Promise<unknown>;
    command(name: string, payload?: Record<string, unknown>): Promise<unknown>;
    private sendCommand;
    private elevate;
    private approveElevation;
    subscribe(event: string, cb: (payload: unknown) => void): () => void;
    subscribeWithMeta(event: string, cb: (payload: unknown, meta: EventMeta) => void): () => void;
    private handleFrame;
    private ensurePush;
    private ensureWs;
    private ensureSse;
    private openSse;
    close(): void;
}
export interface TauriBridge {
    invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
    listen(event: string, cb: (e: {
        payload: unknown;
    }) => void): Promise<() => void>;
}
export declare const FLOWS_BASE_PATH = "/api/hub/flows";
export declare const FLOWS_WHATSAPP_HEADER_IMAGES_PATH = "/api/hub/flows/whatsapp-header-images";
export interface WhatsappHeaderImage {
    ref: string;
    mime_type: 'image/jpeg' | 'image/png';
    size: number;
}
export type WhatsappHeaderMediaKind = 'image' | 'video' | 'document';
export interface WhatsappHeaderMedia {
    ref: string;
    mime_type: 'image/jpeg' | 'image/png' | 'video/mp4' | 'application/pdf';
    size: number;
}
export declare const EVENTS_BASE_PATH = "/api/hub/events";
export declare const RELEASE_REVOKED = "flow.release_revoked";
export declare const MODULE_HEADER = "X-Erplora-Module";
export declare const MODULE_SCOPE_REQUIRED = "module_scope_required";
export declare const INVALID_ARGUMENT = "invalid_argument";
export type CoreMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export interface CoreRequest {
    method: CoreMethod;
    path: string;
    body?: unknown;
    envelope?: boolean;
}
export interface CoreApiTransport {
    coreRequest(req: CoreRequest, headers?: Record<string, string>): Promise<unknown>;
}
export interface Flow {
    id: string;
    name: string;
    enabled: boolean;
    definition: Record<string, unknown>;
    created_by?: string;
    updated_by?: string;
    [k: string]: unknown;
}
export interface FlowInput {
    name: string;
    definition: Record<string, unknown>;
    enabled?: boolean;
}
export interface FlowSchema {
    schema_version: number;
    core_version: string;
    schema: Record<string, unknown>;
}
export interface RunPage<T = unknown> {
    data: T[];
    next_cursor?: string;
}
export declare class FlowsApi {
    private readonly send;
    private readonly moduleId;
    constructor(send: (req: CoreRequest) => Promise<unknown>, moduleId?: string);
    list(): Promise<Flow[]>;
    create(flow: FlowInput): Promise<Flow>;
    get(id: string): Promise<Flow>;
    update(id: string, flow: FlowInput): Promise<Flow>;
    remove(id: string): Promise<unknown>;
    grants(id: string): Promise<unknown[]>;
    replaceGrants(id: string, grants: unknown[]): Promise<unknown[]>;
    run(id: string, input?: Record<string, unknown>): Promise<unknown>;
    runs(id: string, page?: {
        limit?: number;
        before?: string;
    }): Promise<RunPage>;
    getRun(runId: string): Promise<unknown>;
    approvals(status?: string): Promise<unknown[]>;
    approve(approvalId: string, body?: Record<string, unknown>): Promise<unknown>;
    reject(approvalId: string, body?: Record<string, unknown>): Promise<unknown>;
    secrets(): Promise<unknown>;
    putSecret(name: string, value: string): Promise<unknown>;
    deleteSecret(name: string): Promise<unknown>;
    schema(): Promise<FlowSchema>;
    uploadWhatsappHeaderImage(file: Blob): Promise<WhatsappHeaderImage>;
    uploadWhatsappHeaderMedia(file: Blob, kind: WhatsappHeaderMediaKind): Promise<WhatsappHeaderMedia>;
    templates(): Promise<ModuleFlowTemplate[]>;
    templateDiscards(): Promise<FlowTemplateDiscard[]>;
    activateTemplate(family: string): Promise<Flow>;
    deactivateTemplate(family: string): Promise<Flow>;
    restoreTemplate(family: string): Promise<Flow>;
    restoreModuleTemplate(module: string, family: string): Promise<Flow>;
}
export interface FlowTemplateDiscard {
    module: string;
    family: string;
    code: string;
    detail: string;
    requires?: {
        module: string;
        floor: string;
        installed: string | null;
    };
}
export interface ModuleFlowTemplate {
    module: string;
    family: string;
    documents: Record<string, unknown>;
    grants: Array<{
        kind: string;
        value: string;
        payload?: Record<string, unknown>;
        reason?: Record<string, string>;
    }>;
    requires: Record<string, string>;
    installed?: {
        flow_id: string;
        enabled: boolean;
        outdated?: boolean | null;
    } | null;
}
export interface EventFieldShape {
    path: string;
    type: string;
    sample?: unknown;
    redacted: boolean;
    truncated: boolean;
    items?: number;
    seen_in: number;
}
export interface EventShape {
    event_name: string;
    declared_by: string[];
    samples: number;
    last_seen_at?: string;
    fields: EventFieldShape[];
}
export interface EventCatalogEntry {
    name: string;
    declared_by: string[];
    last_seen_at?: string;
}
export interface DeadEvent {
    id: string;
    event_name: string;
    module_id: string;
    user_id: string;
    payload: unknown;
    last_error: string;
    attempts: number;
    depth: number;
    created_at: string;
    failure_kind: string;
    retryable: boolean;
}
export interface DeadCount {
    count: number;
}
export interface RetryAllResult {
    retried: number;
}
export interface DiscardResult {
    id: string;
    status: string;
    discarded_by: string;
    discard_reason?: string;
}
export interface DiscardedEvent {
    id: string;
    event_name: string;
    module_id: string;
    last_error: string;
    created_at: string;
    discarded_at: string;
    discarded_by: string;
    discard_reason: string;
}
export interface CorrelatedEvent {
    id: string;
    event_name: string;
    module_id: string;
    status: string;
    run_id: string;
    parent_event_id: string;
    depth: number;
    created_at: string;
}
export interface EventTrace {
    event: CorrelatedEvent;
    runs: unknown[];
    caused: CorrelatedEvent[];
}
export declare class EventsApi {
    private readonly send;
    constructor(send: (req: CoreRequest) => Promise<unknown>);
    list(): Promise<EventCatalogEntry[]>;
    shape(name: string, opts?: {
        limit?: number;
    }): Promise<EventShape>;
    dead(): Promise<DeadEvent[]>;
    deadCount(): Promise<DeadCount>;
    retry(id: string): Promise<{
        id: string;
        status: string;
    }>;
    discard(id: string, reason?: string): Promise<DiscardResult>;
    discarded(): Promise<DiscardedEvent[]>;
    retryAll(): Promise<RetryAllResult>;
    trace(id: string): Promise<EventTrace>;
}
export declare const WHATSAPP_TEMPLATES_BASE_PATH = "/api/hub/whatsapp/templates";
export declare const WHATSAPP_TEMPLATE_HEADER_SAMPLES_PATH = "/api/hub/whatsapp/template-header-samples";
export interface WhatsappTemplate {
    name: string;
    language: string;
    category?: string;
    status: string;
    rejected_reason?: string;
    meta_id?: string;
    [field: string]: unknown;
}
export interface WhatsappTemplateList {
    templates: WhatsappTemplate[];
    stale: boolean;
}
export interface WhatsappTemplateInput {
    name: string;
    language: string;
    category?: string;
    header_format?: 'TEXT' | WhatsappHeaderSampleFormat;
    header_handle?: string;
    [field: string]: unknown;
}
export type WhatsappHeaderSampleFormat = 'IMAGE' | 'VIDEO' | 'DOCUMENT';
export interface WhatsappTemplateHeaderSample {
    header_handle: string;
    format: WhatsappHeaderSampleFormat;
    mime_type: string;
    size: number;
}
export declare class WhatsappTemplatesApi {
    private readonly send;
    constructor(send: (req: CoreRequest) => Promise<unknown>);
    list(): Promise<WhatsappTemplateList>;
    register(template: WhatsappTemplateInput): Promise<WhatsappTemplate>;
    uploadHeaderSample(file: Blob): Promise<WhatsappTemplateHeaderSample>;
    remove(name: string): Promise<void>;
}
export declare const WHATSAPP_MEDIA_BASE_PATH = "/api/hub/whatsapp/media";
export interface CoreBlobTransport {
    coreBlobRequest(path: string, headers?: Record<string, string>): Promise<Blob>;
}
export declare class WhatsappMediaApi {
    private readonly fetchBlob;
    constructor(fetchBlob: (path: string) => Promise<Blob>);
    get(mediaId: string): Promise<Blob>;
}
export declare const CERTIFICATE_BASE_PATH = "/api/business/certificate";
export interface CertificateSlot {
    present: boolean;
    uploaded_at?: string | null;
    uploaded_by?: string | null;
}
export interface CertificateStatus extends CertificateSlot {
    slots: Record<string, CertificateSlot>;
    active: string | null;
    transmission_route: string;
    [field: string]: unknown;
}
export interface CertificateUpload {
    pkcs12Base64: string;
    password: string;
}
export declare class CertificateApi {
    private readonly send;
    constructor(send: (req: CoreRequest) => Promise<unknown>);
    get(): Promise<CertificateStatus>;
    put(upload: CertificateUpload): Promise<CertificateStatus>;
    remove(): Promise<CertificateStatus>;
}
export declare const PRINT_JOBS_BASE_PATH = "/api/print/jobs";
export interface PrintRetryResult {
    jobId: string;
    status: string;
}
export interface PrintDiscardResult {
    jobId: string;
    discardedAt: string;
    discardedBy: string;
    discardReason: string;
}
export declare class PrintApi {
    private readonly send;
    constructor(send: (req: CoreRequest) => Promise<unknown>);
    retry(jobId: string): Promise<PrintRetryResult>;
    discard(jobId: string, reason?: string): Promise<PrintDiscardResult>;
}
export declare class ErploraClient {
    private readonly transport;
    private readonly opts;
    private bridge?;
    private moduleId?;
    private flowsApi?;
    private eventsApi?;
    private printApi?;
    private whatsappTemplatesApi?;
    private whatsappMediaApi?;
    private certificateApi?;
    constructor(transport: ErploraTransport, opts?: {
        permissions?: () => ReadonlySet<string>;
        notifier?: (n: Notification) => void;
        currency?: () => string;
        currencyDecimals?: () => number;
        timezone?: () => string;
        installedModules?: () => ReadonlySet<string> | undefined;
    }, bridge?: BridgeTransport);
    private static ownerModuleOf;
    private isKnownAbsent;
    get peripherals(): BridgeTransport;
    fetchMediaBlob(ref: string, opts?: MediaFetchOptions): Promise<Blob | null>;
    forModule(moduleId: string): ErploraClient;
    get flows(): FlowsApi;
    get events(): EventsApi;
    get whatsappTemplates(): WhatsappTemplatesApi;
    get whatsappMedia(): WhatsappMediaApi;
    get certificate(): CertificateApi;
    get printQueue(): PrintApi;
    query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
    queryOptional<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T | undefined>;
    queryPage<T = unknown>(name: string, params?: ListParams): Promise<Page<T>>;
    queryAll<T = unknown>(name: string, params?: ListParams): Promise<T[]>;
    queryAllOptional<T = unknown>(name: string, params?: ListParams): Promise<T[] | undefined>;
    command<T = unknown>(name: string, payload?: Record<string, unknown>, opts?: CommandOptions): Promise<T>;
    commandOptional<T = unknown>(name: string, payload?: Record<string, unknown>, opts?: CommandOptions): Promise<T | undefined>;
    on(event: string, cb: (payload: unknown) => void): () => void;
    onEvent(event: string, cb: (payload: unknown, meta: EventMeta) => void): () => void;
    hasPermission(perm: string): boolean;
    notify(n: Notification): void;
    get locale(): string;
    get currency(): string;
    get timezone(): string;
    private moneyFmt;
    formatMoney(minor: number, opts?: FormatMoneyOptions): string;
    get currencyDecimals(): number;
    formatAmount(units: number, opts?: FormatMoneyOptions): string;
    eurosToCents(euros: string | number | undefined): number;
    centsToEuros(cents: number | undefined): string;
    t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
}
export type TransportKind = 'http+ws' | 'http+sse' | 'ws';
export declare function createClient(kind: TransportKind, deps?: {
    http?: HttpWsOptions;
    tauri?: TauriBridge;
}, clientOpts?: ConstructorParameters<typeof ErploraClient>[1]): ErploraClient;
export interface BridgePrinter {
    id: string;
    name: string;
    type: string;
    category?: string;
    status: string;
    paper_width: number;
    mac?: string;
}
export interface BridgeDevice {
    key: string;
    mac?: string;
    ip: string;
    port: number;
    name: string;
    role?: string | null;
    type: string;
    first_seen: string;
    last_seen: string;
    status: string;
}
export interface BridgeStatus {
    online: boolean;
    version?: string;
}
export declare const LOCAL_NETWORK_PERMISSION_DENIED = "local_network_permission_denied";
export type PrinterDiscoveryResult = {
    status: 'scanned';
    printers: BridgePrinter[];
} | {
    status: typeof LOCAL_NETWORK_PERMISSION_DENIED;
    permission?: string;
};
export declare class LocalNetworkPermissionDeniedError extends Error {
    readonly code = "local_network_permission_denied";
    readonly permission?: string;
    constructor(permission?: string, message?: string);
}
export declare function printersOrThrow(outcome: PrinterDiscoveryResult | BridgePrinter[]): BridgePrinter[];
export interface BridgeTransport {
    detect(timeoutMs?: number): Promise<BridgeStatus>;
    discoverPrinters(): Promise<BridgePrinter[]>;
    getDevices(): Promise<BridgeDevice[]>;
    print(printerId: string, documentType: string, data: Record<string, unknown>, jobId?: string): Promise<void>;
    testPrint(printerId: string, data?: Record<string, unknown>): Promise<void>;
    openDrawer(printerId: string, pin?: number): Promise<void>;
    setDeviceRole(keyOrMac: string, role: string): Promise<BridgeDevice[]>;
    addNetworkPrinter?(host: string, port?: number): Promise<BridgePrinter>;
    notify(title: string, body: string): Promise<void>;
}
export declare const HARDWARE_UNAVAILABLE = "hardware_unavailable";
export declare const INVALID_PRINTER_ADDRESS = "invalid_printer_address";
export declare const PRINTER_UNREACHABLE = "printer_unreachable";
export declare const PRINTER_ADD_FAILED = "printer_add_failed";
export declare class UnavailableBridgeTransport implements BridgeTransport {
    private readonly message;
    constructor(message?: string);
    private refuse;
    detect(): Promise<BridgeStatus>;
    discoverPrinters(): Promise<BridgePrinter[]>;
    getDevices(): Promise<BridgeDevice[]>;
    print(): Promise<void>;
    testPrint(): Promise<void>;
    openDrawer(): Promise<void>;
    setDeviceRole(): Promise<BridgeDevice[]>;
    addNetworkPrinter(): Promise<BridgePrinter>;
    notify(): Promise<void>;
}
export declare const ANDROID_LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK";
export declare const ANDROID_NOTIFICATIONS_PERMISSION = "android.permission.POST_NOTIFICATIONS";
export declare const ANDROID_BLUETOOTH_CONNECT_PERMISSION = "android.permission.BLUETOOTH_CONNECT";
export declare class IpcBridgeTransport implements BridgeTransport {
    private readonly tauri;
    constructor(tauri: TauriBridge);
    private ensurePermissions;
    detect(): Promise<BridgeStatus>;
    discoverPrinters(): Promise<BridgePrinter[]>;
    getDevices(): Promise<BridgeDevice[]>;
    print(printerId: string, documentType: string, data: Record<string, unknown>, jobId?: string): Promise<void>;
    testPrint(printerId: string, data?: Record<string, unknown>): Promise<void>;
    openDrawer(printerId: string, pin?: number): Promise<void>;
    setDeviceRole(keyOrMac: string, role: string): Promise<BridgeDevice[]>;
    addNetworkPrinter(host: string, port?: number): Promise<BridgePrinter>;
    notify(title: string, body: string): Promise<void>;
}
export declare function majorToMinor(amount: string | number | undefined, decimals: number): number;
export declare function minorToMajor(amount: number | undefined, decimals: number): number;
export declare function eurosToCents(euros: string | number | undefined): number;
export declare function centsToEuros(cents: number | undefined): string;
export declare function decimalsForCurrency(code: string | undefined): number;

// ── quantity.d.ts ─────────────────────────────────────────────────────────
export declare const QUANTITY_SCALE = 1000000;
export declare function toMicro(quantity: number): number;
export declare function fromMicro(raw: number): number;
export declare function parseQuantity(text: string): number | null;
export declare function formatQuantity(raw: number): string;
export declare function onGrid(raw: number, increment: number): boolean;
