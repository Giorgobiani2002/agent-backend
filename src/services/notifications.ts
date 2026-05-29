/**
 * Telegram notifications for bulk-run completion (and any other events that
 * want to ping the operator out-of-band).
 *
 * Setup: create a bot with @BotFather, message it once, then set:
 *   TELEGRAM_BOT_TOKEN=12345:abcdef…
 *   TELEGRAM_CHAT_ID=<your chat id from @userinfobot>
 *
 * If either var is missing, calls become no-ops — safe to leave unconfigured.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

export function notificationsConfigured(): boolean {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

/**
 * Send a Markdown-formatted message to the configured Telegram chat.
 * Errors are logged but never thrown — notifications must not break runs.
 */
export async function sendTelegramMessage(text: string): Promise<boolean> {
  if (!notificationsConfigured()) return false;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[notifications] Telegram returned ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[notifications] Telegram send failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export interface BulkRunCompletionPayload {
  runId: string;
  status: "succeeded" | "failed" | "cancelled" | "stalled";
  playbookName?: string | null;
  totalRows: number;
  okCount: number;
  failedCount: number;
  durationSec?: number | null;
  cacheHits?: number;
  estCostSavedUsd?: number;
}

/**
 * Format a bulk-run summary for Telegram and send it. Best-effort.
 */
export async function notifyBulkRunComplete(p: BulkRunCompletionPayload): Promise<void> {
  if (!notificationsConfigured()) return;
  const emoji =
    p.status === "succeeded" ? "✅" : p.status === "failed" ? "❌" :
    p.status === "stalled" ? "⏸" : "⚪";
  const lines: string[] = [
    `${emoji} *Bulk run ${p.status}*`,
    p.playbookName ? `📖 ${p.playbookName}` : "",
    `📊 ${p.okCount}/${p.totalRows} ok · ${p.failedCount} failed`,
    p.durationSec != null ? `⏱ ${formatDuration(p.durationSec)}` : "",
    p.cacheHits != null && p.cacheHits > 0
      ? `💾 ${p.cacheHits} cache hits${p.estCostSavedUsd != null ? ` · ~$${p.estCostSavedUsd.toFixed(2)} saved` : ""}`
      : "",
    `\n[View run](http://localhost:3000/runs/${p.runId})`,
  ].filter(Boolean);
  await sendTelegramMessage(lines.join("\n"));
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
