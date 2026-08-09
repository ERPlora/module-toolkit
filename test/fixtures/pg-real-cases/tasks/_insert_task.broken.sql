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
WHERE (:project_id IS NULL OR EXISTS (
        SELECT 1 FROM tasks_project
        WHERE id = :project_id AND hub_id = :hub_id AND is_deleted = 0))
  AND (:parent_task_id IS NULL OR EXISTS (
        SELECT 1 FROM tasks_task
        WHERE id = :parent_task_id AND hub_id = :hub_id AND is_deleted = 0));
