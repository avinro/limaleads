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

export interface InlineKeyboardButton {
  text: string;
  url: string;
}

export interface TelegramAlertOptions {
  parseMode?: 'HTML' | 'MarkdownV2';
  /** Rows of inline keyboard buttons rendered below the message. */
  inlineKeyboard?: InlineKeyboardButton[][];
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

/**
 * Formats a Date as "YYYY-MM-DD · h:mm AM/PM" in the Europe/Madrid timezone.
 * Handles both CET (UTC+1, winter) and CEST (UTC+2, summer) automatically.
 * Uses Intl.DateTimeFormat.formatToParts to guarantee locale-stable output.
 */
function formatMadridDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const dayPeriod = get('dayPeriod');

  return `${year}-${month}-${day} · ${hour}:${minute} ${dayPeriod}`;
}

/**
 * Decodes HTML entities that Gmail embeds in message snippets.
 * Order matters: numeric entities are decoded first; &amp; is decoded last
 * to avoid treating &amp;lt; as < (one decode level only).
 */
function decodeSnippetEntities(str: string): string {
  return str
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// Best-effort reply-separator patterns. Covers the most common email clients
// in English and Spanish. Languages outside this list will not be stripped —
// that is acceptable for MVP; track as a separate issue if needed.
const REPLY_SEPARATOR_PATTERNS: RegExp[] = [
  /\bOn .{0,200}? wrote:/,
  /\bEl .{0,200}? escribi[oó]:/,
  /-----Original Message-----/,
  /^From: /m,
];

/**
 * Cleans a raw Gmail snippet for display in Telegram:
 *   1. Decodes HTML entities (&#39;, &lt;, numeric, etc.).
 *   2. Normalizes whitespace to single spaces.
 *   3. Strips quoted thread history from the first recognized separator onward.
 *   4. Falls back to the decoded (non-stripped) text if stripping leaves < 3 chars.
 *   5. Truncates to 200 chars.
 *
 * The result is plain text ready to be passed through htmlEscape before
 * embedding in a Telegram HTML message.
 */
function cleanSnippet(raw: string): string {
  const decoded = decodeSnippetEntities(raw).replace(/\s+/g, ' ').trim();

  let stripped = decoded;
  for (const pattern of REPLY_SEPARATOR_PATTERNS) {
    const matchIndex = stripped.search(pattern);
    if (matchIndex !== -1) {
      stripped = stripped.slice(0, matchIndex).trim();
      break;
    }
  }

  const result = stripped.length >= 3 ? stripped : decoded;
  return result.slice(0, 200);
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

  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (options?.parseMode) {
    body.parse_mode = options.parseMode;
  }
  if (options?.inlineKeyboard) {
    body.reply_markup = { inline_keyboard: options.inlineKeyboard };
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
 * Message format:
 *   Lead replied:
 *   {Name} — {Title} @ {Company}
 *   {date in Europe/Madrid, e.g. "2026-05-04 · 12:23 PM"}
 *
 *   "{reply body, stripped of quoted thread history}"
 *
 * Timestamp source: reply.repliedAt, derived from Gmail message internalDate.
 * This is the moment Gmail received the email — NOT the job run time or
 * the DB replied_at write time.
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
  const snippet = htmlEscape(cleanSnippet(reply.snippet));
  const threadUrl = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(reply.threadId)}`;
  const timestamp = formatMadridDate(reply.repliedAt);

  const text = [
    '<b>Lead replied:</b>',
    `${name} — ${title} @ ${company}`,
    `<i>${timestamp}</i>`,
    '',
    `"${snippet}"`,
  ].join('\n');

  const alertOptions: TelegramAlertOptions = {
    parseMode: 'HTML',
    inlineKeyboard: [[{ text: '📬 Open in Gmail', url: threadUrl }]],
  };

  try {
    await sendTelegramAlert(text, alertOptions);
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
    await sendTelegramAlert(text, alertOptions);
  }
}
