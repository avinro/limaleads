// AVI-21: Read-only Gmail helper for reply detection.
//
// Inspects a Gmail thread to determine whether the lead has replied to the
// outreach email after the send was confirmed (contacted_at).
//
// Key differences from gmailCorrelation (sent detection):
//   - Looks for messages FROM the lead, not from the rep.
//   - Excludes SENT and DRAFT labels — inbound replies arrive in INBOX.
//   - Reference timestamp is contacted_at, not created_at.
//   - No subject-fallback: the job query pre-filters leads to those with a
//     gmail_thread_id, so we always have a thread to inspect.
//   - 404 on thread fetch → null (thread deleted or access revoked).
//
// Reply identity: strict per AVI-21 AC. A message counts as a reply only
// when the From header contains lead.email (case-insensitive). This handles
// "Display Name <email>" formatting and avoids false positives from CCs,
// notifications, or unrelated parties in the thread. If alias/assistant
// support is required, address that in a dedicated follow-up issue.

import { google } from 'googleapis';
import { getOAuth2Client } from './gmailAuth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadReplyInput {
  id: string;
  email: string;
  gmail_thread_id: string;
  contacted_at: string;
}

export interface ReplyResult {
  messageId: string;
  threadId: string;
  repliedAt: Date;
  fromAddress: string;
  /** Gmail-provided plain-text snippet (~200 chars). Empty string if not returned. */
  snippet: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHeader(
  headers: Array<{ name?: string | null; value?: string | null }>,
  name: string,
): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/**
 * Returns true if the From header contains lead.email (case-insensitive).
 * Handles both plain addresses and "Display Name <email>" formatting.
 */
function isFromLead(
  headers: Array<{ name?: string | null; value?: string | null }>,
  leadEmail: string,
): boolean {
  return getHeader(headers, 'from').toLowerCase().includes(leadEmail.toLowerCase());
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Searches the lead's Gmail thread for an inbound reply from the lead.
 *
 * A message qualifies as a reply when ALL of:
 *   1. labelIds does NOT include SENT (not an outbound rep message)
 *   2. labelIds does NOT include DRAFT
 *   3. From header contains lead.email
 *   4. internalDate >= contacted_at - 60s (60s clock-skew tolerance)
 *
 * Returns the earliest qualifying message, or null if none found.
 * Returns null (does not throw) on 404 — thread may be deleted or inaccessible.
 * Rethrows all other Gmail API errors.
 */
export async function findReplyForLead(lead: LeadReplyInput): Promise<ReplyResult | null> {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const contactedAtMs = new Date(lead.contacted_at).getTime();
  // 60-second tolerance for clock skew between Supabase writes and Gmail timestamps.
  const cutoffMs = contactedAtMs - 60_000;

  let threadMessages: Array<{
    id?: string | null;
    threadId?: string | null;
    labelIds?: string[] | null;
    internalDate?: string | null;
    snippet?: string | null;
    payload?: {
      headers?: Array<{ name?: string | null; value?: string | null }> | null;
    } | null;
  }>;

  try {
    const threadResponse = await gmail.users.threads.get({
      userId: 'me',
      id: lead.gmail_thread_id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject'],
    });
    threadMessages = threadResponse.data.messages ?? [];
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      return null;
    }
    throw error;
  }

  const candidates = threadMessages.filter((msg) => {
    const labelIds = msg.labelIds ?? [];
    if (labelIds.includes('SENT') || labelIds.includes('DRAFT')) return false;

    const headers = msg.payload?.headers ?? [];
    if (!isFromLead(headers, lead.email)) return false;

    const internalDate = Number(msg.internalDate ?? 0);
    if (internalDate < cutoffMs) return false;

    return true;
  });

  if (candidates.length === 0) return null;

  // Pick the earliest valid reply to avoid re-triggering on follow-up threads.
  candidates.sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
  const best = candidates[0]!;

  return {
    messageId: best.id!,
    threadId: best.threadId!,
    repliedAt: new Date(Number(best.internalDate ?? 0)),
    fromAddress: getHeader(best.payload?.headers ?? [], 'from'),
    snippet: best.snippet ?? '',
  };
}
