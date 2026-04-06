CREATE TABLE IF NOT EXISTS relay_threads (
  thread_id TEXT PRIMARY KEY,
  upstream_profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relay_threads_profile
  ON relay_threads (upstream_profile_id, updated_at DESC);
