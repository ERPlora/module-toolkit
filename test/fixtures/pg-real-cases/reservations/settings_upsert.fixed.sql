-- Upsert de la config de reservas del hub (1 fila por hub_id). Runtime inyecta
-- :new_id (usado solo en alta), :hub_id, :current_user_id, :now.
-- Portado de ReservationService.update_settings + get_settings (creación lazy). ON CONFLICT(hub_id)
-- actualiza solo los campos enviados (COALESCE(:bind, tabla.col) = no tocar si NULL).
-- Requiere el índice único uq_reservations_settings_hub.
--
-- La autorreferencia del DO UPDATE va CUALIFICADA (`reservations_settings.col`) y no es estilo:
-- sin cualificar, PostgreSQL no sabe si el nombre es la fila persistida o la de `excluded` y la
-- sentencia NO PARSEA («column reference ... is ambiguous») — el command entero dejaba de existir.
-- Cubierto por tests/settings_upsert.pg.test.py contra un Postgres real.
INSERT INTO reservations_settings
  (id, hub_id, time_slot_duration, min_party_size, max_party_size,
   min_advance_hours, max_advance_days, auto_confirm, require_phone, require_email,
   no_show_window_minutes, default_duration_minutes,
   send_confirmation_email, send_reminder_email, reminder_hours_before,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id,
   COALESCE(:time_slot_duration, 30), COALESCE(:min_party_size, 1), COALESCE(:max_party_size, 20),
   COALESCE(:min_advance_hours, 1), COALESCE(:max_advance_days, 30), COALESCE(:auto_confirm, 0),
   COALESCE(:require_phone, 1), COALESCE(:require_email, 0),
   COALESCE(:no_show_window_minutes, 15), COALESCE(:default_duration_minutes, 120),
   COALESCE(:send_confirmation_email, 0), COALESCE(:send_reminder_email, 0),
   COALESCE(:reminder_hours_before, 24),
   0, :current_user_id, :current_user_id, :now, :now)
ON CONFLICT(hub_id) DO UPDATE SET
   time_slot_duration       = COALESCE(:time_slot_duration, reservations_settings.time_slot_duration),
   min_party_size           = COALESCE(:min_party_size, reservations_settings.min_party_size),
   max_party_size           = COALESCE(:max_party_size, reservations_settings.max_party_size),
   min_advance_hours        = COALESCE(:min_advance_hours, reservations_settings.min_advance_hours),
   max_advance_days         = COALESCE(:max_advance_days, reservations_settings.max_advance_days),
   auto_confirm             = COALESCE(:auto_confirm, reservations_settings.auto_confirm),
   require_phone            = COALESCE(:require_phone, reservations_settings.require_phone),
   require_email            = COALESCE(:require_email, reservations_settings.require_email),
   no_show_window_minutes   = COALESCE(:no_show_window_minutes, reservations_settings.no_show_window_minutes),
   default_duration_minutes = COALESCE(:default_duration_minutes, reservations_settings.default_duration_minutes),
   send_confirmation_email  = COALESCE(:send_confirmation_email, reservations_settings.send_confirmation_email),
   send_reminder_email      = COALESCE(:send_reminder_email, reservations_settings.send_reminder_email),
   reminder_hours_before    = COALESCE(:reminder_hours_before, reservations_settings.reminder_hours_before),
   updated_by               = :current_user_id,
   updated_at               = :now;
