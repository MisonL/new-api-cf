CREATE TABLE IF NOT EXISTS usage_daily (
  usage_date TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  model TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, actor_kind, actor_id, model)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_date
  ON usage_daily (usage_date DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_daily_actor
  ON usage_daily (actor_kind, actor_id, usage_date DESC);
