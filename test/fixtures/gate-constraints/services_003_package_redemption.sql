-- Services · consumo de bonos/paquetes (Postgres / Aurora cloud). Equivalente a
-- migrations/sqlite/003_package_redemption.sql — mismas tablas, índices, FK y contrato de
-- fila del hub (§2.5). Generado por paridad mecánica.
--
-- Tipos: subconjunto portable "ERPlora SQL" (ADR-0007): ids/refs → TEXT; flags 0/1 → INTEGER;
-- FECHAS → TEXT ISO-8601 (NO TIMESTAMPTZ): el motor de sync compara updated_at como string
-- lexicográfico. El CHECK (ok = 1) de la tabla guardia aborta el statement en ambos dialectos.

CREATE TABLE IF NOT EXISTS services_package_redemption (
    id             TEXT PRIMARY KEY,
    hub_id         TEXT NOT NULL,
    package_id     TEXT NOT NULL,
    customer_id    TEXT NOT NULL,
    appointment_id TEXT,
    sale_id        TEXT,
    note           TEXT NOT NULL DEFAULT '',
    redeemed_at    TEXT NOT NULL,
    is_deleted     INTEGER NOT NULL DEFAULT 0,
    deleted_at     TEXT,
    created_by     TEXT,
    updated_by     TEXT,
    created_at     TEXT,
    updated_at     TEXT,
    FOREIGN KEY (package_id) REFERENCES services_package (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_services_redemption_pkg_cust
    ON services_package_redemption (hub_id, package_id, customer_id, is_deleted);

CREATE TABLE IF NOT EXISTS services__gate (
    gate TEXT NOT NULL,
    ok   INTEGER NOT NULL CHECK (ok = 1)
);
