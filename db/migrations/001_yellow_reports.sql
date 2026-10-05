-- Phase A: Yellow cockpit reports + optional trades.source
-- Apply with: turso db shell <db-name> < db/migrations/001_yellow_reports.sql
-- Safe / recoverable: CREATE IF NOT EXISTS only. Does not wipe existing trades.
-- If `trades.source` already exists, the ALTER below will error — ignore that line.

CREATE TABLE IF NOT EXISTS yellow_reports (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  symbol TEXT DEFAULT 'XAUUSD',
  bias TEXT,
  levels TEXT,                 -- JSON array/object of levels
  decision TEXT,               -- skip | take
  entry REAL,
  sl REAL,
  tp REAL,
  lot REAL DEFAULT 0.01,
  hold_seconds INTEGER,
  margin REAL,
  pnl REAL,
  balance REAL,
  equity REAL,
  session_window TEXT,         -- e.g. "06:00-08:00" | "18:00-20:00" | "out"
  notes TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_yellow_reports_created ON yellow_reports(created_at DESC);

-- Prefer Yellow rows in the journal when this column is present.
-- Ignore error if column already exists:
-- ALTER TABLE trades ADD COLUMN source TEXT DEFAULT 'legacy';
