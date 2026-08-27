SELECT COALESCE(SUM(amount_cents), 0) AS total_cents
FROM kernel_fixture_item
WHERE hub_id = :hub_id AND deleted_at IS NULL
