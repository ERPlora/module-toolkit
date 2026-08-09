-- Whatsapp_inbox · esquema inicial (Postgres / Aurora cloud). Equivalente a
-- migrations/sqlite/001_init.sql — mismas tablas, índices, FK y contrato de fila del
-- hub (§2.5): hub_id + soft-delete + auditoría. Generado por paridad mecánica.
--
-- Tipos: subconjunto portable "ERPlora SQL" (ADR-0007):
--   * ids/refs → TEXT (UUIDs del runtime como texto);
--   * flags 0/1 → INTEGER (los commands bindean 0/1; Postgres no castea entero→bool);
--   * importes → NUMERIC;
--   * FECHAS → TEXT ISO-8601 (NO TIMESTAMPTZ): el motor de sync (ADR-0031) compara
--     updated_at como string lexicográfico; timestamptz rompería el LWW entre dialectos.

CREATE TABLE IF NOT EXISTS whatsapp_inbox_settings (
    id                        TEXT PRIMARY KEY,
    hub_id                    TEXT NOT NULL,
    is_enabled                INTEGER NOT NULL DEFAULT 0,
    account_mode              TEXT NOT NULL DEFAULT 'shared',     -- shared|per_employee
    auto_reply_enabled        INTEGER NOT NULL DEFAULT 1,
    approval_mode             TEXT NOT NULL DEFAULT 'auto',       -- auto|manual
    require_confirmation       INTEGER NOT NULL DEFAULT 1,
    request_schema            TEXT NOT NULL DEFAULT '{}',         -- JSON: esquema dinámico de requests
    gpt_system_prompt         TEXT NOT NULL DEFAULT '',
    input_modules             TEXT NOT NULL DEFAULT '[]',         -- JSON array de module_id (catálogo/contexto)
    output_modules            TEXT NOT NULL DEFAULT '[]',         -- JSON array de module_id (destino de requests)
    auto_close_hours          INTEGER NOT NULL DEFAULT 24,
    notify_staff_new_request  INTEGER NOT NULL DEFAULT 1,
    greeting_message          TEXT NOT NULL DEFAULT '',
    out_of_hours_message      TEXT NOT NULL DEFAULT '',
    is_deleted                INTEGER NOT NULL DEFAULT 0,
    deleted_at                TEXT,
    created_by                TEXT,
    updated_by                TEXT,
    created_at                TEXT NOT NULL,
    updated_at                TEXT
);
-- Singleton por hub (UniqueConstraint unique_wa_inbox_settings_per_hub).
CREATE UNIQUE INDEX IF NOT EXISTS ix_wa_settings_hub          ON whatsapp_inbox_settings (hub_id);
CREATE INDEX        IF NOT EXISTS idx_whatsapp_inbox_settings_hub ON whatsapp_inbox_settings (hub_id, is_deleted);

-- Mapeo empleado→número de WhatsApp Business (modo per_employee).
-- employee_id referencia al usuario local (tabla propiedad del shell/core, no de un módulo).
CREATE TABLE IF NOT EXISTS whatsapp_inbox_employee_link (
    id               TEXT PRIMARY KEY,
    hub_id           TEXT NOT NULL,
    employee_id      TEXT NOT NULL,
    phone_number_id  TEXT NOT NULL,
    display_phone    TEXT NOT NULL,
    is_active        INTEGER NOT NULL DEFAULT 1,
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    deleted_at       TEXT,
    created_by       TEXT,
    updated_by       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT
);
-- (hub, phone_number_id) único (UniqueConstraint unique_wa_phone_per_hub).
CREATE UNIQUE INDEX IF NOT EXISTS ix_wa_link_hub_phone     ON whatsapp_inbox_employee_link (hub_id, phone_number_id);
CREATE INDEX        IF NOT EXISTS ix_wa_link_hub_employee  ON whatsapp_inbox_employee_link (hub_id, employee_id);
CREATE INDEX        IF NOT EXISTS idx_whatsapp_inbox_employee_link_hub ON whatsapp_inbox_employee_link (hub_id, is_deleted);

-- Conversación con un contacto de WhatsApp.
-- customer_id/assigned_to_id son referencias blandas (el módulo no toca esas tablas;
-- se resuelven vía contratos/queries públicas de customers y del core de usuarios).
-- context es JSON libre (estado del bot por conversación).
CREATE TABLE IF NOT EXISTS whatsapp_inbox_conversation (
    id               TEXT PRIMARY KEY,
    hub_id           TEXT NOT NULL,
    customer_id      TEXT,
    assigned_to_id   TEXT,
    phone_number_id  TEXT NOT NULL DEFAULT '',
    wa_contact_id    TEXT NOT NULL,
    contact_name     TEXT NOT NULL,
    contact_phone    TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active',   -- active|closed|...
    last_message_at  TEXT,
    context          TEXT NOT NULL DEFAULT '{}',       -- JSON: estado del bot
    unread_count     INTEGER NOT NULL DEFAULT 0,
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    deleted_at       TEXT,
    created_by       TEXT,
    updated_by       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS ix_wa_conv_hub_contact   ON whatsapp_inbox_conversation (hub_id, wa_contact_id);
CREATE INDEX IF NOT EXISTS ix_wa_conv_hub_status    ON whatsapp_inbox_conversation (hub_id, status);
CREATE INDEX IF NOT EXISTS ix_wa_conv_hub_assigned  ON whatsapp_inbox_conversation (hub_id, assigned_to_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_conversation_hub ON whatsapp_inbox_conversation (hub_id, is_deleted);

-- Mensaje individual de una conversación. direction: inbound|outbound.
-- extra_metadata es JSON libre (renombrado de la columna "metadata" legacy).
CREATE TABLE IF NOT EXISTS whatsapp_inbox_message (
    id               TEXT PRIMARY KEY,
    hub_id           TEXT NOT NULL,
    conversation_id  TEXT NOT NULL,
    direction        TEXT NOT NULL,                    -- inbound|outbound
    wa_message_id    TEXT NOT NULL,
    message_type     TEXT NOT NULL DEFAULT 'text',
    body             TEXT NOT NULL DEFAULT '',
    media_url        TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'received',
    extra_metadata   TEXT NOT NULL DEFAULT '{}',       -- JSON libre
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    deleted_at       TEXT,
    created_by       TEXT,
    updated_by       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT,
    FOREIGN KEY (conversation_id) REFERENCES whatsapp_inbox_conversation (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_wa_msg_hub_wamsgid  ON whatsapp_inbox_message (hub_id, wa_message_id);
CREATE INDEX IF NOT EXISTS ix_wa_msg_conv         ON whatsapp_inbox_message (hub_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_message_hub ON whatsapp_inbox_message (hub_id, is_deleted);

-- Request parseada por IA desde una conversación (esquema dinámico en data JSON).
-- reference_number es estable y único por hub. request_type: order|reservation|
-- appointment|quote|transport|custom. status: pending_review|confirmed|rejected|
-- fulfilled|cancelled. linked_module/linked_object_id apuntan al objeto creado en
-- otro módulo al cumplir la request (vía contrato de eventos, nunca import directo).
CREATE TABLE IF NOT EXISTS whatsapp_inbox_request (
    id               TEXT PRIMARY KEY,
    hub_id           TEXT NOT NULL,
    conversation_id  TEXT NOT NULL,
    customer_id      TEXT,
    reference_number TEXT NOT NULL,
    request_type     TEXT NOT NULL DEFAULT 'custom',
    status           TEXT NOT NULL DEFAULT 'pending_review',
    data             TEXT NOT NULL DEFAULT '{}',        -- JSON: datos estructurados parseados por IA
    raw_summary      TEXT NOT NULL DEFAULT '',
    confidence_score REAL NOT NULL DEFAULT 0,         -- confianza IA 0.0–1.0 (no es dinero) → REAL portable (ADR-0007)
    notes            TEXT NOT NULL DEFAULT '',
    assigned_to_id   TEXT,
    linked_module    TEXT NOT NULL DEFAULT '',
    linked_object_id TEXT,
    confirmed_at     TEXT,
    fulfilled_at     TEXT,
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    deleted_at       TEXT,
    created_by       TEXT,
    updated_by       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT,
    FOREIGN KEY (conversation_id) REFERENCES whatsapp_inbox_conversation (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_wa_req_hub_status  ON whatsapp_inbox_request (hub_id, status);
CREATE INDEX IF NOT EXISTS ix_wa_req_hub_type    ON whatsapp_inbox_request (hub_id, request_type);
CREATE INDEX IF NOT EXISTS ix_wa_req_hub_ref     ON whatsapp_inbox_request (hub_id, reference_number);
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_request_hub ON whatsapp_inbox_request (hub_id, is_deleted);

-- Plantilla de mensaje de WhatsApp Business (aprobada por Meta).
-- category: MARKETING|UTILITY|AUTHENTICATION. meta_status: pending|approved|rejected.
-- variables es JSON array (nombres de variables {{1}}, {{2}}...).
CREATE TABLE IF NOT EXISTS whatsapp_inbox_template (
    id               TEXT PRIMARY KEY,
    hub_id           TEXT NOT NULL,
    name             TEXT NOT NULL,
    language         TEXT NOT NULL DEFAULT 'es',
    category         TEXT NOT NULL DEFAULT 'UTILITY',   -- MARKETING|UTILITY|AUTHENTICATION
    header           TEXT NOT NULL DEFAULT '',
    body             TEXT NOT NULL DEFAULT '',
    footer           TEXT NOT NULL DEFAULT '',
    meta_template_id TEXT NOT NULL DEFAULT '',
    meta_status      TEXT NOT NULL DEFAULT 'pending',   -- pending|approved|rejected
    variables        TEXT NOT NULL DEFAULT '[]',        -- JSON array
    is_active        INTEGER NOT NULL DEFAULT 1,
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    deleted_at       TEXT,
    created_by       TEXT,
    updated_by       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS ix_wa_template_hub        ON whatsapp_inbox_template (hub_id);
CREATE INDEX IF NOT EXISTS ix_wa_template_hub_name   ON whatsapp_inbox_template (hub_id, name);
CREATE INDEX IF NOT EXISTS ix_wa_template_hub_status ON whatsapp_inbox_template (hub_id, meta_status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_template_hub ON whatsapp_inbox_template (hub_id, is_deleted);