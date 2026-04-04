CREATE TABLE IF NOT EXISTS usage_daily_next (
  usage_date TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  upstream_profile_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, actor_kind, actor_id, upstream_profile_id, model)
);

INSERT INTO usage_daily_next (
  usage_date,
  actor_kind,
  actor_id,
  upstream_profile_id,
  model,
  request_count,
  success_count,
  error_count,
  last_status,
  updated_at
)
SELECT
  usage_date,
  actor_kind,
  actor_id,
  '',
  model,
  request_count,
  success_count,
  error_count,
  last_status,
  updated_at
FROM usage_daily;

DROP TABLE usage_daily;

ALTER TABLE usage_daily_next RENAME TO usage_daily;

CREATE INDEX IF NOT EXISTS idx_usage_daily_date
  ON usage_daily (usage_date DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_daily_actor
  ON usage_daily (actor_kind, actor_id, usage_date DESC);

CREATE INDEX IF NOT EXISTS idx_usage_daily_profile
  ON usage_daily (upstream_profile_id, usage_date DESC);
