-- Motor de disponibilidad: slots libres de un día (WASM-TODO pieza 8 / get_available_slots).
-- Va como query declarativa Tier 0 (no WASM): el contrato runtime↔WASM devuelve intenciones,
-- no datos al caller, así que esta lógica de calendario (lectura + cómputo) vive en SQL.
--
-- Genera las franjas candidatas de :date en pasos de `slot_interval` entre
-- `calendar_start_hour` y `calendar_end_hour` (settings del hub, con defaults si no hay
-- fila) y descarta las que:
--   · violan la antelación mínima (`min_booking_notice`) o máxima (`max_advance_booking`),
--   · caen fuera de los tramos activos de horario del día — solo si el hub tiene horarios
--     configurados (sin horarios, valen las horas de calendario),
--   · chocan con tiempo bloqueado (del hub entero, o del :staff_id si se pide),
--   · se solapan con citas vivas (status fuera de cancelled/no_show), salvo
--     `allow_overlapping`.
--
-- Binds: :date (YYYY-MM-DD, requerido) · :staff_id (opcional; ausente = agenda global)
--        · :duration_minutes (opcional; default = settings.default_duration).
-- Runtime inyecta :hub_id y :now. Un bind ausente llega como NULL (centinela del adapter).
-- Fechas/horas vía funciones-puente erp_* (ADR-0007 §4a): erp_dt (datetime comparable),
-- erp_date (parte fecha), erp_dateadd (suma intervalo), erp_dow_mon0 (día de semana 0=lunes),
-- erp_timefmt (HH:MM). Las fechas se guardan como TEXT ISO-8601.
WITH RECURSIVE
cfg AS (
    SELECT COALESCE(MAX(calendar_start_hour), 8)   AS start_hour,
           COALESCE(MAX(calendar_end_hour),   20)  AS end_hour,
           COALESCE(MAX(slot_interval),       15)  AS step,
           COALESCE(COALESCE(:duration_minutes, MAX(default_duration)), 60) AS dur,
           COALESCE(MAX(min_booking_notice),  60)  AS notice_min,
           COALESCE(MAX(max_advance_booking), 90)  AS advance_days,
           COALESCE(MAX(allow_overlapping),    0)  AS allow_overlapping,
           erp_dow_mon0(:date) AS dow
    FROM appointments_settings
    WHERE hub_id = :hub_id AND is_deleted = 0
),
slots(m) AS (
    SELECT start_hour * 60 FROM cfg
    UNION ALL
    SELECT s.m + c.step FROM slots s, cfg c WHERE s.m + c.step + c.dur <= c.end_hour * 60
),
cand AS (
    SELECT s.m AS start_min,
           s.m + c.dur AS end_min,
           :date || 'T' || erp_timefmt(s.m / 60, s.m % 60) || ':00' AS slot_start,
           :date || 'T' || erp_timefmt((s.m + c.dur) / 60, (s.m + c.dur) % 60) || ':00' AS slot_end
    FROM slots s, cfg c
    WHERE s.m + c.dur <= c.end_hour * 60
)
SELECT c.slot_start,
       c.slot_end,
       erp_timefmt(c.start_min / 60, c.start_min % 60) AS start_time,
       erp_timefmt(c.end_min / 60, c.end_min % 60)     AS end_time
FROM cand c, cfg
WHERE
    -- antelación mínima / máxima respecto a :now
    erp_dt(c.slot_start) >= erp_dateadd(:now, cfg.notice_min, 'minutes')
    AND erp_date(:date) <= erp_date(erp_dateadd(:now, cfg.advance_days, 'days'))
    -- dentro de un tramo activo del horario (si el hub tiene horarios configurados)
    AND (
        NOT EXISTS (
            SELECT 1
            FROM appointments_schedule_timeslot t
            JOIN appointments_schedule sc ON sc.id = t.schedule_id
            WHERE t.hub_id = :hub_id AND t.is_deleted = 0 AND t.is_active = 1
              AND sc.is_deleted = 0 AND sc.is_active = 1
        )
        OR EXISTS (
            SELECT 1
            FROM appointments_schedule_timeslot t
            JOIN appointments_schedule sc ON sc.id = t.schedule_id
            WHERE t.hub_id = :hub_id AND t.is_deleted = 0 AND t.is_active = 1
              AND sc.is_deleted = 0 AND sc.is_active = 1
              AND t.day_of_week = cfg.dow
              AND (CAST(substr(t.start_time, 1, 2) AS INTEGER) * 60
                   + CAST(substr(t.start_time, 4, 2) AS INTEGER)) <= c.start_min
              AND c.end_min <= (CAST(substr(t.end_time, 1, 2) AS INTEGER) * 60
                                + CAST(substr(t.end_time, 4, 2) AS INTEGER))
        )
    )
    -- sin tiempo bloqueado (hub entero = staff_id NULL; o el del :staff_id pedido)
    AND NOT EXISTS (
        SELECT 1
        FROM appointments_blocked_time b
        WHERE b.hub_id = :hub_id AND b.is_deleted = 0
          AND (b.staff_id IS NULL OR b.staff_id = ''
               OR (:staff_id IS NOT NULL AND b.staff_id = :staff_id))
          AND (
              (b.all_day = 1 AND erp_date(b.start_datetime) <= erp_date(:date)
                             AND erp_date(:date) <= erp_date(b.end_datetime))
              OR (erp_dt(b.start_datetime) < erp_dt(c.slot_end)
                  AND erp_dt(b.end_datetime) > erp_dt(c.slot_start))
          )
    )
    -- sin citas vivas que solapen (salvo allow_overlapping); con :staff_id solo su agenda
    AND (
        cfg.allow_overlapping = 1
        OR NOT EXISTS (
            SELECT 1
            FROM appointments_appointment a
            WHERE a.hub_id = :hub_id AND a.is_deleted = 0
              AND a.status NOT IN ('cancelled', 'no_show')
              AND (:staff_id IS NULL OR a.staff_id = :staff_id)
              AND erp_dt(a.start_datetime) < erp_dt(c.slot_end)
              AND erp_dt(a.end_datetime) > erp_dt(c.slot_start)
        )
    )
ORDER BY c.start_min;
