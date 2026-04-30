// Gmail API client — sends emails and detects replies via OAuth2.
// Credentials are loaded from env vars; the googleapis library handles
// access token refresh automatically using the stored refresh token.
//
// MVP decision: the refresh token is stored in an env var (Railway secret in
// production, .env locally). Multi-user support would require encrypted
// per-user token storage in Supabase — tracked as a separate future issue.

import { google } from 'googleapis';
import { getOAuth2Client } from './gmailAuth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendEmailOptions {
  to: string;
  subject: string;
  /** Plain-text body. HTML not needed for outreach emails. */
  body: string;
  /** Pass the original thread ID to send as a reply in the same thread. */
  threadId?: string;
}

export interface SentEmail {
  messageId: string;
  threadId: string;
}

export interface GmailMessage {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: Date;
}

// ---------------------------------------------------------------------------
// Email encoding
// ---------------------------------------------------------------------------

/**
 * Encodes an email message as RFC 2822 base64url string required by the Gmail API.
 */
function encodeEmail(options: SendEmailOptions, threadId?: string): string {
  const headers = [
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];

  if (threadId) {
    // Thread-ID header keeps the reply in the same Gmail conversation
    headers.push(`In-Reply-To: ${threadId}`);
    headers.push(`References: ${threadId}`);
  }

  const raw = [...headers, '', options.body].join('\r\n');

  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function getHeader(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string,
): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Sends an email via the Gmail API.
 * Returns the message ID and thread ID for tracking in Supabase.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SentEmail> {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodeEmail(options, options.threadId),
      threadId: options.threadId,
    },
  });

  const { id, threadId } = response.data;

  if (!id || !threadId) {
    throw new Error('Gmail API returned a message without id or threadId');
  }

  return { messageId: id, threadId };
}

/**
 * Returns unread messages received after the given date.
 * Used by the reply detector to find responses from leads.
 */
export async function listUnreadReplies(since: Date): Promise<GmailMessage[]> {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  // Gmail query: unread messages in inbox received after the given timestamp
  const afterTimestamp = Math.floor(since.getTime() / 1000);
  const query = `is:unread in:inbox after:${afterTimestamp}`;

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 100,
  });

  const messages = listResponse.data.messages ?? [];

  if (messages.length === 0) {
    return [];
  }

  // Fetch full metadata for each message in parallel
  const fullMessages = await Promise.all(
    messages.map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const headers = detail.data.payload?.headers ?? [];
      const internalDate = Number(detail.data.internalDate ?? 0);

      return {
        messageId: detail.data.id!,
        threadId: detail.data.threadId!,
        from: getHeader(headers, 'From'),
        subject: getHeader(headers, 'Subject'),
        snippet: detail.data.snippet ?? '',
        receivedAt: new Date(internalDate),
      };
    }),
  );

  return fullMessages;
}
