-- 010_settings.sql — tables#3 (c): room settings, one row per hub.
--
-- The `settings` nav entry promised a screen it never had. What the market keeps as ROOM settings
-- is small and operational (Square "table management settings": colour indicators after N minutes
-- + track cover count; Lightspeed: "cover count prompt" per floor plan; Toast / Revel: table
-- service settings in back-office): whether seating asks for the covers, and after how many
-- minutes an open check turns amber / red. That is what this row holds. Defaults live in the JSON
-- Schema (`schemas/settings_update.json`): a hub that never saved anything behaves like the
-- schema says, and the row is only created on the first save (upsert on `hub_id`).
CREATE TABLE IF NOT EXISTS tables_settings (
    id                      TEXT PRIMARY KEY,
    hub_id                  TEXT NOT NULL UNIQUE,
    prompt_guests_on_seat   INTEGER NOT NULL DEFAULT 1,
    timer_warning_minutes   INTEGER NOT NULL DEFAULT 60,
    timer_critical_minutes  INTEGER NOT NULL DEFAULT 90,
    is_deleted              INTEGER NOT NULL DEFAULT 0,
    deleted_at              TEXT,
    created_by              TEXT,
    updated_by              TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT
);
