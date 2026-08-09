-- Inserta la tarea. task_number TSK-YYYYMMDD-NNNN se calcula leyendo el contador
-- (recién incrementado por _bump_counter) en la MISMA transacción (sin read-back
-- desde el guest). Guardas FK del PROPIO módulo en el WHERE (runtime sin lecturas
-- pre-cargadas): si :project_id o :parent_task_id no existen vivos en este hub,
-- el INSERT es un no-op (equivalente a project_not_found / parent_not_found).
-- La unique ix_task_hub_number (hub_id, task_number) es la guarda final.
-- Padding portable: erp_pad(valor, ancho) (ADR-0007) → printf('%0*d',...) en SQLite y
-- lpad(...,'0') en Postgres, resuelto por el shim del runtime.
INSERT INTO tasks_task (
    id, hub_id, task_number, title, description, project_id, status, priority,
    assigned_to_ref, created_by_ref, due_date, completed_at, parent_task_id, tags,
    is_deleted, created_by, updated_by, created_at, updated_at
)
SELECT
    :task_id, :hub_id,
    'TSK-' || :day || '-' || erp_pad((
        SELECT last_number FROM tasks_counter WHERE hub_id = :hub_id AND day = :day
    ), 4),
    :title, :description, :project_id, 'todo', :priority,
    :assigned_to_ref, :created_by_ref, :due_date, NULL, :parent_task_id, :tags,
    0, :current_user_id, :current_user_id, :now, :now
-- Los centinelas van CASTEADOS y no es estilo: Postgres fija el tipo de un bind en su PRIMERA
-- aparición y `IS NULL` no aporta ninguno, así que con la ref ausente (NULL, que es su default en
-- schemas/create_task.json) el bind viaja sin tipo y el PREPARE muere con 42P08 «could not
-- determine data type of parameter» — el alta normal de tarea, sin proyecto ni padre, no llegaba
-- ni a ejecutarse. `CAST(:p AS TEXT)` fija el tipo en los dos dialectos (ADR-0007).
-- Cubierto por tests/insert_task.pg.test.py contra un Postgres real.
WHERE (CAST(:project_id AS TEXT) IS NULL OR EXISTS (
        SELECT 1 FROM tasks_project
        WHERE id = :project_id AND hub_id = :hub_id AND is_deleted = 0))
  AND (CAST(:parent_task_id AS TEXT) IS NULL OR EXISTS (
        SELECT 1 FROM tasks_task
        WHERE id = :parent_task_id AND hub_id = :hub_id AND is_deleted = 0));
