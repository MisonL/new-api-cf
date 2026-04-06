CREATE TABLE IF NOT EXISTS relay_assistants (
  assistant_id TEXT PRIMARY KEY,
  upstream_profile_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relay_assistants_profile
  ON relay_assistants (upstream_profile_id, updated_at DESC);
