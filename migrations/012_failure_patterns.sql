-- Phase Q2: Closed-loop failure learning.
-- Every K1 (typed-value hallucination), M1 (vision validator), K4 (URL guard),
-- and post-condition failure gets POSTed here from the Python agent. The
-- backend dedupes on (domain, url_pattern, field_label, failure_type),
-- incrementing occurrence_count. Future runs in the same domain inject the
-- top patterns into the Worker prompt as "WATCH OUT FOR ..." so the agent
-- doesn't re-hit the same wall on day-2 that it hit on day-1.

CREATE TABLE IF NOT EXISTS agent_failure_patterns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain            text NOT NULL,
  url_pattern       text,
  field_label       text,
  failure_type      text NOT NULL CHECK (failure_type IN (
                      'k1_hallucination',
                      'm1_zero_field',
                      'm1_not_confirmation',
                      'k4_url',
                      'postcondition',
                      'manual'
                    )),
  symptom           text NOT NULL,
  workaround        text,
  occurrence_count  int  NOT NULL DEFAULT 1,
  first_seen_at     timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at      timestamptz NOT NULL DEFAULT NOW()
);

-- Dedup key: same domain + url + label + type → bump count instead of inserting.
-- COALESCE-ed into UNIQUE-able strings (NULLs are not equal in PostgreSQL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_failure_patterns_dedup
  ON agent_failure_patterns (
    domain,
    COALESCE(url_pattern, ''),
    COALESCE(field_label, ''),
    failure_type
  );

CREATE INDEX IF NOT EXISTS idx_failure_patterns_domain_recent
  ON agent_failure_patterns (domain, last_seen_at DESC);
