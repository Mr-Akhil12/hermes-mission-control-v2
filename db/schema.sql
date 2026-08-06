-- Hermes OS v2 — Turso schema (single data layer)
-- Apply with: turso db shell <db> < schema.sql

-- tasks: dispatch queue
create table if not exists tasks (
  id text primary key default (lower(hex(randomblob(16)))),
  prompt text not null,
  profile text default 'default',
  status text default 'queued',          -- queued | running | done | failed | cancelled
  result text,
  error text,
  model text,
  created_at text default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at text,
  finished_at text,
  source text default 'pwa'              -- pwa | cron | bridge
);

-- content_pipeline: studio kanban
create table if not exists content_pipeline (
  id text primary key default (lower(hex(randomblob(16)))),
  platform text not null,                -- youtube | x | linkedin | tiktok | blog
  title text not null,
  status text default 'idea',            -- idea | approved | scheduled | posted | rejected
  viral_score numeric,
  scheduled_for text,
  posted_at text,
  draft text,
  links text,                            -- JSON
  created_at text default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- sync_cache: mirrored native state
create table if not exists sync_cache (
  key text primary key,                  -- 'crons' | 'approvals' | 'sessions' | 'channels' | 'cron_runs'
  payload text not null,                 -- JSON
  updated_at text default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- briefs: daily brief history
create table if not exists briefs (
  id text primary key,                   -- 'YYYY-MM-DD'
  date text not null,
  content text not null,                 -- JSON
  created_at text default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- artifacts: every produced file as a LINK (never a blob)
create table if not exists artifacts (
  id text primary key default (lower(hex(randomblob(16)))),
  title text not null,
  kind text not null,                    -- video | html | plan | research | text | image | audio
  repo text not null,                    -- hyperframes | hermes-dump | agenticbiz | akhils-trading | ...
  path text not null,                    -- repo-relative path
  url text not null,                     -- GitHub URL (or Vercel URL for deployed)
  source text,                           -- session id or cron job id
  created_at text default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists idx_artifacts_kind on artifacts(kind);
create index if not exists idx_artifacts_source on artifacts(source);
