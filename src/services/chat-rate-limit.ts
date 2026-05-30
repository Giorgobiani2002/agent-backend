import { query } from "../db";
import { HttpError } from "../errors";

/**
 * Per-company-per-hour message cap on the chat brain to keep Gemini
 * spend bounded when a tenant goes wild (intentionally or otherwise).
 *
 * Default 60 messages/hour/company — generous for a real accountant
 * doing diagnostic work, hard cap on a runaway script.
 *
 * Lives in Postgres (not in-process map) so multiple agent-backend
 * replicas share the counter, and so we have a historical record
 * of who's heavy. The bucket is the truncated hour timestamp; a
 * fresh row appears at the top of each hour.
 *
 * Backend env var: CHAT_MAX_MSGS_PER_HOUR (default 60).
 * Set to 0 to disable rate limiting entirely (not recommended for prod).
 */

const DEFAULT_LIMIT = 60;

function limit(): number {
  const raw = Number(process.env.CHAT_MAX_MSGS_PER_HOUR ?? DEFAULT_LIMIT);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_LIMIT;
  return raw;
}

/**
 * Bump the counter for (companyId, current hour). Throws HttpError 429
 * when the company is already over the per-hour limit.
 *
 * Call BEFORE invoking Gemini so we don't burn the request first then
 * decide to reject. The increment is the gate.
 */
export async function checkAndBumpChatLimit(companyId: string): Promise<{
  count: number;
  limit: number;
}> {
  const cap = limit();
  if (cap === 0) return { count: 0, limit: 0 };

  const bucket = new Date();
  bucket.setMinutes(0, 0, 0); // truncate to top of hour
  const bucketIso = bucket.toISOString();

  const result = await query<{ message_count: number }>(
    `
      INSERT INTO chat_usage_hourly (company_id, hour_bucket, message_count, last_seen_at)
      VALUES ($1, $2, 1, now())
      ON CONFLICT (company_id, hour_bucket)
      DO UPDATE SET
        message_count = chat_usage_hourly.message_count + 1,
        last_seen_at = now()
      RETURNING message_count
    `,
    [companyId, bucketIso],
  );
  const count = result.rows[0].message_count;

  if (count > cap) {
    // We bumped past the cap. Surface a 429 so the rs-client proxy
    // can render a "you've hit your hourly limit" message inline.
    throw new HttpError(
      429,
      `Chat rate limit reached: ${count}/${cap} messages this hour for company. Try again next hour.`,
    );
  }

  return { count, limit: cap };
}

/** Record the actual token spend after a successful Gemini call. */
export async function recordChatTokens(
  companyId: string,
  outputTokens: number,
): Promise<void> {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return;
  const bucket = new Date();
  bucket.setMinutes(0, 0, 0);
  await query(
    `UPDATE chat_usage_hourly
       SET output_tokens = output_tokens + $3,
           last_seen_at = now()
       WHERE company_id = $1 AND hour_bucket = $2`,
    [companyId, bucket.toISOString(), Math.floor(outputTokens)],
  ).catch((err) => {
    // Best-effort: missing usage row shouldn't blow up the chat path.
    console.warn(
      "[chat-rate-limit] recordChatTokens failed:",
      err instanceof Error ? err.message : err,
    );
  });
}
