// Gmail draft-to-sent correlation.
//
// Determines whether a Gmail draft was sent by the rep, and whether the rep
// edited it before sending. Used by AVI-19 (sent detection job) — this module
// is intentionally read-only: it never writes to Supabase.

import { google } from 'googleapis';
import { getOAuth2Client, getRepSenderEmail } from './gmailAuth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadCorrelationInput {
  id: string;
  email: string;
  gmail_thread_id: string | null;
  draft_subject: string | null;
  draft_body: string | null;
  created_at: string;
}

export interface SentMessageResult {
  messageId: string;
  threadId: string;
  sentAt: Date;
  body: string;
  editedBeforeSend: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHeader(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string,
): string {
  return (
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
  );
}

/**
 * Decodes a base64url-encoded Gmail message part data field to a UTF-8 string.
 */
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Extracts plain-text body from a Gmail message payload.
 * Prefers text/plain; falls back to text/html with tags stripped.
 */
function extractPlainBody(
  payload: {
    mimeType?: string | null;
    body?: { data?: string | null } | null;
    parts?: Array<{
      mimeType?: string | null;
      body?: { data?: string | null } | null;
    }> | null;
  } | null | undefined,
): string {
  if (!payload) return '';

  // Single-part plain text
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Single-part HTML (strip tags)
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data).replace(/<[^>]*>/g, '');
  }

  if (!payload.parts) return '';

  // Multipart — prefer the text/plain part
  const plainPart = payload.parts.find((p) => p.mimeType === 'text/plain');
  if (plainPart?.body?.data) {
    return decodeBase64Url(plainPart.body.data);
  }

  const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
  if (htmlPart?.body?.data) {
    return decodeBase64Url(htmlPart.body.data).replace(/<[^>]*>/g, '');
  }

  return '';
}

/**
 * Normalizes a body string for comparison:
 * collapses whitespace, normalizes line endings, trims.
 */
function normalizeBody(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Returns true if the sent body differs meaningfully from the stored draft body.
 * If draft_body is null or blank, returns false (no baseline to compare).
 */
export function detectEdit(draftBody: string | null, sentBody: string): boolean {
  if (!draftBody || !draftBody.trim()) return false;
  return normalizeBody(draftBody) !== normalizeBody(sentBody);
}

/**
 * Returns true if the given email address appears in the To, Cc, or Bcc header.
 */
function addressedTo(
  headers: Array<{ name?: string | null; value?: string | null }>,
  email: string,
): boolean {
  const lowerEmail = email.toLowerCase();
  for (const field of ['to', 'cc', 'bcc']) {
    if (getHeader(headers, field).toLowerCase().includes(lowerEmail)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if the From header belongs to the rep's sender address.
 */
function sentByRep(
  headers: Array<{ name?: string | null; value?: string | null }>,
  repEmail: string,
): boolean {
  return getHeader(headers, 'from').toLowerCase().includes(repEmail.toLowerCase());
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Searches Gmail for a sent message that matches this lead's draft.
 *
 * Strategy (thread-first, subject fallback):
 *   1. If gmail_thread_id is set, fetch the full thread and look for a message
 *      that (a) has the SENT label, (b) is From the rep, (c) is To the lead,
 *      and (d) was sent after the lead's created_at.
 *      If multiple messages match, choose the earliest valid one.
 *   2. If no threadId or no match found, and draft_subject is set, query the
 *      SENT label with a subject filter, then apply the same From/To validation.
 *   3. If no message found → return null.
 *
 * This function is pure with respect to Supabase — it never writes anything.
 * AVI-19 is responsible for persisting the result (updating edited_before_send
 * and transitioning the lead to contacted).
 */
export async function findSentMessageForLead(
  lead: LeadCorrelationInput,
): Promise<SentMessageResult | null> {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const repEmail = await getRepSenderEmail();
  const createdAtMs = new Date(lead.created_at).getTime();

  // ---------------------------------------------------------------------------
  // Strategy 1 — thread lookup
  // ---------------------------------------------------------------------------
  if (lead.gmail_thread_id) {
    const threadResponse = await gmail.users.threads.get({
      userId: 'me',
      id: lead.gmail_thread_id,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date'],
    });

    const threadMessages = threadResponse.data.messages ?? [];

    // Filter messages that look like the rep sending the draft
    const candidates = threadMessages.filter((msg) => {
      const labelIds = msg.labelIds ?? [];
      if (!labelIds.includes('SENT')) return false;

      const headers = msg.payload?.headers ?? [];
      if (!sentByRep(headers, repEmail)) return false;
      if (!addressedTo(headers, lead.email)) return false;

      const internalDate = Number(msg.internalDate ?? 0);
      // Accept messages sent at or after lead creation (with 60s tolerance for
      // clock skew between our DB write and Gmail's internal timestamp).
      if (internalDate < createdAtMs - 60_000) return false;

      return true;
    });

    if (candidates.length > 0) {
      // Pick the earliest valid candidate
      candidates.sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
      const best = candidates[0]!;

      // Fetch full body for the chosen message
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: best.id!,
        format: 'full',
      });

      const body = extractPlainBody(full.data.payload);

      return {
        messageId: full.data.id!,
        threadId: full.data.threadId!,
        sentAt: new Date(Number(full.data.internalDate ?? 0)),
        body,
        editedBeforeSend: detectEdit(lead.draft_body, body),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Strategy 2 — subject fallback
  // Only attempted when a draft_subject was recorded; avoids unbounded searches.
  // ---------------------------------------------------------------------------
  if (!lead.draft_subject) {
    return null;
  }

  const query = `in:sent subject:"${lead.draft_subject.replace(/"/g, '')}"`;

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 20,
  });

  const candidateIds = listResponse.data.messages ?? [];
  if (candidateIds.length === 0) return null;

  // Fetch metadata for each candidate in parallel, then filter
  const metaResults = await Promise.all(
    candidateIds.map((msg) =>
      gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date'],
      }),
    ),
  );

  const validMeta = metaResults
    .map((r) => r.data)
    .filter((msg) => {
      const headers = msg.payload?.headers ?? [];
      if (!sentByRep(headers, repEmail)) return false;
      if (!addressedTo(headers, lead.email)) return false;
      const internalDate = Number(msg.internalDate ?? 0);
      if (internalDate < createdAtMs - 60_000) return false;
      return true;
    })
    .sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));

  if (validMeta.length === 0) return null;

  const bestMeta = validMeta[0]!;

  // Fetch full body
  const full = await gmail.users.messages.get({
    userId: 'me',
    id: bestMeta.id!,
    format: 'full',
  });

  const body = extractPlainBody(full.data.payload);

  return {
    messageId: full.data.id!,
    threadId: full.data.threadId!,
    sentAt: new Date(Number(full.data.internalDate ?? 0)),
    body,
    editedBeforeSend: detectEdit(lead.draft_body, body),
  };
}
