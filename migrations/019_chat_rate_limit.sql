-- Per-company-per-hour chat usage counter. Keeps Gemini bills bounded
-- when a single tenant goes wild (intentionally or accidentally).
--
-- The counter row is keyed on (company_id, hour_bucket). A failed-write
-- on the unique index means "we already have a row for this hour" and
-- we just bump count. The middleware (services/chat-rate-limit.ts)
-- reads + increments atomically via INSERT ... ON CONFLICT.

CREATE TABLE IF NOT EXISTS chat_usage_hourly (
  company_id    text NOT NULL,
  hour_bucket   timestamptz NOT NULL,
  message_count int NOT NULL DEFAULT 0,
  -- Approximate output tokens charged. The Gemini SDK exposes this
  -- after each call; the middleware doesn't read it pre-flight so
  -- the limit is per-message not per-token. We still store tokens
  -- for visibility into who's actually heavy.
  output_tokens bigint NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_chat_usage_hourly_last_seen
  ON chat_usage_hourly (last_seen_at DESC);
