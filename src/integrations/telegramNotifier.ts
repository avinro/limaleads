// Telegram Bot API notifier — sends alert messages to a configured chat.
//
// Designed as a soft-failure helper: if env vars are absent the function logs
// a warning and returns without throwing. This keeps alerting out of the
// critical pipeline path.
//
// Scale-up path: replace TELEGRAM_CHAT_ID with a group or channel ID to
// broadcast to multiple team members without any code changes.

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Sends a text alert message via the Telegram Bot API.
 *
 * Soft failure: logs a warning and resolves if TELEGRAM_BOT_TOKEN or
 * TELEGRAM_CHAT_ID env vars are absent.
 *
 * Hard failure: throws if the Telegram API returns a non-2xx response,
 * which surfaces misconfigured credentials early.
 */
export async function sendTelegramAlert(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn(
      'sendTelegramAlert: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping alert.',
    );
    return;
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${responseBody}`);
  }
}
