-- Inserta el mensaje entrante. Runtime inyecta :new_id (ID del mensaje), :hub_id,
-- :current_user_id, :now. La capa gratuita se aplica si free_tier_monthly_limit > 0:
-- se cuenta el total de mensajes inbound del mes en curso (mes calendario de :now)
-- y se bloquea el INSERT cuando count >= límite → el runtime devuelve error al caller.
-- 0 filas = límite superado; el caller (webhook handler) debe registrar el rechazo.
INSERT INTO whatsapp_inbox_message
  (id, hub_id, conversation_id, direction, wa_message_id, message_type,
   body, media_url, status, extra_metadata,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :new_id,
  :hub_id,
  (SELECT id FROM whatsapp_inbox_conversation
   WHERE hub_id = :hub_id AND wa_contact_id = :wa_contact_id AND is_deleted = 0
   LIMIT 1),
  'inbound',
  :wa_message_id,
  :message_type,
  :body,
  :media_url,
  'received',
  :extra_metadata,
  0, :current_user_id, :current_user_id, :now, :now
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_inbox_settings s
  WHERE s.hub_id = :hub_id AND s.is_deleted = 0
    AND s.free_tier_monthly_limit > 0
    AND (
      SELECT COUNT(*) FROM whatsapp_inbox_message m
      WHERE m.hub_id = :hub_id AND m.direction = 'inbound' AND m.is_deleted = 0
        AND m.created_at >= erp_month_start(:now)
    ) >= s.free_tier_monthly_limit
);
