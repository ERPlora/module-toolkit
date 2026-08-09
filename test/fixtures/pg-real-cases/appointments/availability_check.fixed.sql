-- Motor de disponibilidad: ¿está libre una franja concreta? (WASM-TODO pieza 8 /
-- check_availability). Query declarativa Tier 0 — misma lógica que availability_slots
-- pero para UNA franja, devolviendo `available` (0/1) y el primer `reason` que falla:
--   invalid_start | too_soon | too_far | outside_schedule | blocked | overlap | ''
--
-- Binds: :start_datetime (ISO 8601, requerido) · :duration_minutes (opcional; default =
-- settings.default_duration) · :staff_id (opcional; ausente = agenda global).
-- Runtime inyecta :hub_id y :now. Fechas/horas vía funciones-puente erp_* (ADR-0007 §4a):
-- erp_dt (datetime comparable), erp_date (parte fecha), erp_dateadd (suma intervalo),
-- erp_dow_mon0 (día de semana 0=lunes), erp_extract (hora/minuto). Fechas en TEXT ISO-8601.
-- :staff_id va CASTEADO (`CAST(:staff_id AS TEXT)`) y no es estilo: Postgres fija el tipo de un
-- bind en su PRIMERA aparición y `IS [NOT] NULL` no aporta ninguno, así que sin :staff_id —la
-- agenda global, o sea la llamada normal— el bind viajaba sin tipo y el PREPARE moría con 42P08.
-- Mismo idioma que ya usa queries/appointments_list.sql. Cubierto por tests/availability.pg.test.py.
WITH cfg AS (
    SELECT COALESCE(COALESCE(:duration_minutes, MAX(default_duration)), 60) AS dur,
           COALESCE(MAX(min_booking_notice),  60) AS notice_min,
           COALESCE(MAX(max_advance_booking), 90) AS advance_days,
           COALESCE(MAX(allow_overlapping),    0) AS allow_overlapping
    FROM appointments_settings
    WHERE hub_id = :hub_id AND is_deleted = 0
),
win AS (
    SELECT erp_dt(:start_datetime) AS s_start,
           erp_dateadd(:start_datetime, c.dur, 'minutes') AS s_end,
           erp_dow_mon0(:start_datetime) AS dow,
           erp_extract('hour', :start_datetime) * 60
             + erp_extract('minute', :start_datetime) AS start_min,
           erp_extract('hour', :start_datetime) * 60
             + erp_extract('minute', :start_datetime) + c.dur AS end_min
    FROM cfg c
),
checks AS (
    SELECT
        CASE WHEN w.s_start IS NULL THEN 1 ELSE 0 END AS invalid_start,
        CASE WHEN w.s_start < erp_dateadd(:now, c.notice_min, 'minutes')
             THEN 1 ELSE 0 END AS too_soon,
        CASE WHEN erp_date(w.s_start) > erp_date(erp_dateadd(:now, c.advance_days, 'days'))
             THEN 1 ELSE 0 END AS too_far,
        CASE WHEN EXISTS (
                 SELECT 1
                 FROM appointments_schedule_timeslot t
                 JOIN appointments_schedule sc ON sc.id = t.schedule_id
                 WHERE t.hub_id = :hub_id AND t.is_deleted = 0 AND t.is_active = 1
                   AND sc.is_deleted = 0 AND sc.is_active = 1
             )
             AND NOT EXISTS (
                 SELECT 1
                 FROM appointments_schedule_timeslot t
                 JOIN appointments_schedule sc ON sc.id = t.schedule_id
                 WHERE t.hub_id = :hub_id AND t.is_deleted = 0 AND t.is_active = 1
                   AND sc.is_deleted = 0 AND sc.is_active = 1
                   AND t.day_of_week = w.dow
                   AND (CAST(substr(t.start_time, 1, 2) AS INTEGER) * 60
                        + CAST(substr(t.start_time, 4, 2) AS INTEGER)) <= w.start_min
                   AND w.end_min <= (CAST(substr(t.end_time, 1, 2) AS INTEGER) * 60
                                     + CAST(substr(t.end_time, 4, 2) AS INTEGER))
             )
             THEN 1 ELSE 0 END AS outside_schedule,
        CASE WHEN EXISTS (
                 SELECT 1
                 FROM appointments_blocked_time b
                 WHERE b.hub_id = :hub_id AND b.is_deleted = 0
                   AND (b.staff_id IS NULL OR b.staff_id = ''
                        OR (CAST(:staff_id AS TEXT) IS NOT NULL AND b.staff_id = :staff_id))
                   AND (
                       (b.all_day = 1 AND erp_date(b.start_datetime) <= erp_date(w.s_start)
                                      AND erp_date(w.s_start) <= erp_date(b.end_datetime))
                       OR (erp_dt(b.start_datetime) < w.s_end
                           AND erp_dt(b.end_datetime) > w.s_start)
                   )
             )
             THEN 1 ELSE 0 END AS blocked,
        CASE WHEN c.allow_overlapping = 0 AND EXISTS (
                 SELECT 1
                 FROM appointments_appointment a
                 WHERE a.hub_id = :hub_id AND a.is_deleted = 0
                   AND a.status NOT IN ('cancelled', 'no_show')
                   AND (CAST(:staff_id AS TEXT) IS NULL OR a.staff_id = :staff_id)
                   AND erp_dt(a.start_datetime) < w.s_end
                   AND erp_dt(a.end_datetime) > w.s_start
             )
             THEN 1 ELSE 0 END AS overlap
    FROM win w, cfg c
)
SELECT
    CASE WHEN invalid_start + too_soon + too_far + outside_schedule + blocked + overlap = 0
         THEN 1 ELSE 0 END AS available,
    CASE
        WHEN invalid_start = 1 THEN 'invalid_start'
        WHEN too_soon = 1 THEN 'too_soon'
        WHEN too_far = 1 THEN 'too_far'
        WHEN outside_schedule = 1 THEN 'outside_schedule'
        WHEN blocked = 1 THEN 'blocked'
        WHEN overlap = 1 THEN 'overlap'
        ELSE ''
    END AS reason
FROM checks;
