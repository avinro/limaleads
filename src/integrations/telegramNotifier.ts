// Telegram Bot API notifier — sends alert messages to a configured chat.
//
// Designed as a soft-failure helper: if env vars are absent the function logs
// a warning and returns without throwing. This keeps alerting out of the
// critical pipeline path.
//
// Scale-up path: replace TELEGRAM_CHAT_ID with a group or channel ID to
// broadcast to multiple team members without any code changes.

import { serializeError } from '../lib/errors';
import { logJob } from '../lib/logger';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramAlertOptions {
  parseMode?: 'HTML' | 'MarkdownV2';
}

export interface NotifyLeadReplyInput {
  lead: {
    id: string;
    name: string | null;
    company: string | null;
    title: string | null;
  };
  reply: {
    threadId: string;
    snippet: string;
    repliedAt: Date;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function htmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
export async function sendTelegramAlert(
  text: string,
  options?: TelegramAlertOptions,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn(
      'sendTelegramAlert: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping alert.',
    );
    return;
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  const body: Record<string, string> = { chat_id: chatId, text };
  if (options?.parseMode) {
    body.parse_mode = options.parseMode;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${responseBody}`);
  }
}

/**
 * Sends a rich HTML Telegram notification when a lead replies.
 *
 * Retry contract (AVI-22):
 *   - First failure is logged to job_log with willRetry: true, then retried
 *     after 500 ms.
 *   - Second failure propagates to the caller so replyDetectionJob can log
 *     it with step: 'notify' and count it as a notification error.
 *
 * Soft-skip: delegates to sendTelegramAlert, which skips silently when env
 * vars are absent — no retry is performed in that case.
 */
export async function notifyLeadReply(input: NotifyLeadReplyInput): Promise<void> {
  const { lead, reply } = input;

  const name = htmlEscape(lead.name ?? 'Unknown');
  const company = htmlEscape(lead.company ?? 'Unknown');
  const title = htmlEscape(lead.title ?? 'Unknown');
  const snippet = htmlEscape(reply.snippet.slice(0, 200));
  const threadUrl = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(reply.threadId)}`;
  const timestamp = reply.repliedAt.toISOString();

  const text = [
    `<b>Lead replied:</b> ${name} — ${title} @ ${company}`,
    `<i>${timestamp}</i>`,
    '',
    `"${snippet}"`,
    '',
    `<a href="${threadUrl}">Open thread in Gmail</a>`,
  ].join('\n');

  try {
    await sendTelegramAlert(text, { parseMode: 'HTML' });
  } catch (firstError) {
    await logJob('reply-detection', 'error', {
      step: 'notify',
      leadId: lead.id,
      attempt: 1,
      maxAttempts: 2,
      willRetry: true,
      error: serializeError(firstError),
    });

    await wait(500);

    // Second attempt — let it propagate on failure
    await sendTelegramAlert(text, { parseMode: 'HTML' });
  }
}
