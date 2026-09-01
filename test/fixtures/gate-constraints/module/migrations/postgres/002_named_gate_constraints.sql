-- Each gate refuses UNDER ITS OWN NAME (module-toolkit#92): the identity moves from the ROW to the
-- CONSTRAINT NAME, which is part of the primary message DETAIL never reaches.
ALTER TABLE gatedemo__gate DROP CONSTRAINT IF EXISTS gatedemo__gate_ok_check;

ALTER TABLE gatedemo__gate ADD CONSTRAINT stock_is_available
    CHECK (gate <> 'stock_is_available' OR ok = 1);

ALTER TABLE gatedemo__gate ADD CONSTRAINT gatedemo__gate_is_declared
    CHECK (gate IN ('stock_is_available'));
