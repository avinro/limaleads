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

export interface DraftResult {
  draftId: string;
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
 *
 * @param rfc2822MessageId - The RFC 2822 Message-ID of the original email to reply to
 *   (looks like <CABcXX...@mail.gmail.com>). When set, adds In-Reply-To and References
 *   headers so the recipient's email client threads the messages together. Do NOT pass
 *   a Gmail internal threadId here — that is a different identifier and not recognised
 *   by external mail servers.
 */
function encodeEmail(options: SendEmailOptions, rfc2822MessageId?: string): string {
  const headers = [
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];

  if (rfc2822MessageId) {
    headers.push(`In-Reply-To: ${rfc2822MessageId}`);
    headers.push(`References: ${rfc2822MessageId}`);
  }

  const raw = [...headers, '', options.body].join('\r\n');

  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Thread helpers
// ---------------------------------------------------------------------------

/**
 * Fetches the RFC 2822 Message-ID header of the first message in a Gmail thread.
 * This is the value that must appear in In-Reply-To / References headers of a
 * reply so that the recipient's mail server threads the messages together.
 *
 * Returns null when the thread has no messages or the header is absent.
 */
async function getRfc2822MessageIdFromThread(
  gmail: ReturnType<typeof google.gmail>,
  threadId: string,
): Promise<string | null> {
  const thread = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['Message-ID'],
  });

  const messages = thread.data.messages ?? [];

  if (messages.length === 0) return null;

  const headers = messages[0].payload?.headers ?? [];

  return headers.find((h) => h.name?.toLowerCase() === 'message-id')?.value ?? null;
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
 * Creates a Gmail draft without sending it.
 * Returns draftId (identifies the draft), messageId and threadId
 * (used for sent-detection and thread correlation by AVI-19).
 *
 * Requires the gmail.compose OAuth scope — regenerate the token with
 * `npm run gmail:auth` after adding the scope if this throws 403.
 */
export async function createGmailDraft(options: SendEmailOptions): Promise<DraftResult> {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  // When creating a follow-up draft in an existing thread, fetch the RFC 2822
  // Message-ID of the first message so In-Reply-To/References are set correctly.
  // This is what makes the recipient's mail client thread the messages together.
  // The Gmail-internal threadId alone is not recognised by external mail servers.
  let rfc2822MessageId: string | undefined;

  if (options.threadId) {
    rfc2822MessageId = (await getRfc2822MessageIdFromThread(gmail, options.threadId)) ?? undefined;
  }

  const response = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw: encodeEmail(options, rfc2822MessageId),
        threadId: options.threadId,
      },
    },
  });

  const draftId = response.data.id;
  const messageId = response.data.message?.id;
  const threadId = response.data.message?.threadId;

  if (!draftId || !messageId || !threadId) {
    throw new Error('Gmail API returned an incomplete draft response');
  }

  return { draftId, messageId, threadId };
}

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
      raw: encodeEmail(options),
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
