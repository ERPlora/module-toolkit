-- Guard table: an assert inserts (gate, ok) and `ok = 0` rolls the command transaction back.
CREATE TABLE IF NOT EXISTS gatedemo__gate (
    gate TEXT NOT NULL,
    ok   INTEGER NOT NULL CHECK (ok = 1)
);
