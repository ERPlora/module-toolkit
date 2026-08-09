-- Whatsapp_inbox · esquema inicial (Postgres / Aurora cloud). Equivalente a
-- migrations/sqlite/002_free_tier.sql — mismas tablas, índices, FK y contrato de fila del
-- hub (§2.5): hub_id + soft-delete + auditoría. Generado por paridad mecánica.
--
-- Tipos: subconjunto portable "ERPlora SQL" (ADR-0007):
--   * ids/refs → TEXT (UUIDs del runtime como texto);
--   * flags 0/1 → INTEGER (los commands bindean 0/1; Postgres no castea entero→bool);
--   * importes → NUMERIC;
--   * FECHAS → TEXT ISO-8601 (NO TIMESTAMPTZ): el motor de sync (ADR-0031) compara
--     updated_at como string lexicográfico; timestamptz rompería el LWW entre dialectos.

CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_conv_hub_contact
  ON whatsapp_inbox_conversation (hub_id, wa_contact_id);

-- Límite mensual de mensajes entrantes de la capa gratuita.
-- 0 = sin límite (plan de pago o sin enforcement). El valor concreto lo fija
-- el marketplace/billing del Cloud Portal al provisionar el módulo (owner:human).
ALTER TABLE whatsapp_inbox_settings
  ADD COLUMN free_tier_monthly_limit INTEGER NOT NULL DEFAULT 0;