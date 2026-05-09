-- Dominion Financial – Phase 1 DB Migrations
-- Run this once against Abdul's PostgreSQL database before executing any Playwright scripts.
-- Tables: BGE account map, BGE audit log, Water audit log

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. BGE Account → Property mapping
--    Populated from Jack's spreadsheet (Step 5 of Phase 1).
--    One row per BGE account number, linked to a property in the PROPERTY table.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bge_account_property_map (
  id                  SERIAL PRIMARY KEY,
  bge_account_number  TEXT NOT NULL UNIQUE,
  property_address    TEXT NOT NULL,
  property_id         INTEGER NOT NULL REFERENCES property(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bge_map_property_id ON bge_account_property_map(property_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. BGE portal run audit log
--    Written by bge.spec.ts after every action (navigate, paperless, bill retrieval).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bge_portal_audit_log (
  id                  SERIAL PRIMARY KEY,
  bge_account_number  TEXT NOT NULL,
  property_id         INTEGER NOT NULL REFERENCES property(id),
  action              TEXT NOT NULL,       -- 'navigate' | 'paperless_enrollment' | 'bill_retrieval'
  status              TEXT NOT NULL,       -- 'SUCCESS' | 'FAILED' | 'PARTIAL'
  bill_amount         NUMERIC(10, 2),
  due_date            TEXT,
  notes               TEXT,
  run_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bge_log_account ON bge_portal_audit_log(bge_account_number);
CREATE INDEX IF NOT EXISTS idx_bge_log_run_at  ON bge_portal_audit_log(run_at DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Water portal run audit log
--    Written by water.spec.ts. Includes consumption + threshold decision.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS water_portal_audit_log (
  id                SERIAL PRIMARY KEY,
  unit_id           INTEGER NOT NULL REFERENCES unit(id),
  property_id       INTEGER NOT NULL REFERENCES property(id),
  action            TEXT NOT NULL,         -- 'navigate' | 'paperless_enrollment' | 'bill_retrieval'
  status            TEXT NOT NULL,         -- 'SUCCESS' | 'FAILED' | 'PARTIAL'
  bill_amount       NUMERIC(10, 2),
  consumption_units NUMERIC(10, 3),        -- HCF/CCF/gallons — unit confirmed during audit
  due_date          TEXT,
  threshold_action  TEXT,                  -- 'auto_pay' | 'pay_alert_pm' | 'pay_work_order'
  notes             TEXT,
  run_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_water_log_unit_id ON water_portal_audit_log(unit_id);
CREATE INDEX IF NOT EXISTS idx_water_log_run_at  ON water_portal_audit_log(run_at DESC);
CREATE INDEX IF NOT EXISTS idx_water_log_threshold ON water_portal_audit_log(threshold_action)
  WHERE threshold_action IN ('pay_alert_pm', 'pay_work_order');
