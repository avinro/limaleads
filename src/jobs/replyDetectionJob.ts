// AVI-21: Reply detection job — polls contacted leads and marks them replied
// when a qualifying inbound message is found in their Gmail thread.
//
// Queried lead statuses:
//   contacted      — initial outreach sent; awaiting reply
//   follow_up_sent — follow-up sent; still eligible for reply
//
// Flow per poll:
//   1. Query up to GMAIL_REPLY_POLL_MAX_LEADS leads with status in
//      ('contacted', 'follow_up_sent') and a non-null gmail_thread_id, oldest first.
//   2. For each lead, call findReplyForLead.
//   3. No match → skip (lead has not replied yet).
//   4. Match:
//        a. UPDATE replied_at (before the RPC so the timestamp survives a retry).
//        b. transitionLeadStatus → 'replied'.
//        c. Call the optional onReplyDetected callback (AVI-22 injection point).
//
// Idempotency: query is by status, NOT replied_at. If persistRepliedFields
// succeeds but the RPC fails, the lead stays in 'contacted'/'follow_up_sent'
// and the next poll re-detects the same reply and retries the RPC. replied_at
// may be overwritten with a slightly later value — acceptable for MVP.
//
// onReplyDetected errors are caught so a notification failure never prevents
// the 'replied' transition from being recorded in the audit log.

import { getSupabaseClient } from '../db/client';
import {
  findReplyForLead,
  type LeadReplyInput,
  type ReplyResult,
} from '../integrations/gmailReply';
import { serializeError } from '../lib/errors';
import { transitionLeadStatus } from '../lib/leadStatus';
import { logJob } from '../lib/logger';

const JOB_TYPE = 'reply-detection';
const DEFAULT_MAX_LEADS = 100;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getMaxLeads(): number {
  const raw = process.env.GMAIL_REPLY_POLL_MAX_LEADS;
  if (!raw) return DEFAULT_MAX_LEADS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    console.warn(
      `Invalid GMAIL_REPLY_POLL_MAX_LEADS "${raw}"; using default ${DEFAULT_MAX_LEADS}`,
    );
    return DEFAULT_MAX_LEADS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplyDetectionSummary {
  scanned: number;
  replied: number;
  pending: number;
  failed: number;
  capped: boolean;
}

/**
 * AVI-22 injection point.
 * AVI-21 calls this with the lead and reply data after a successful transition.
 * Replace the no-op default in index.ts with the Telegram notifier in AVI-22.
 */
export type ReplyCallback = (lead: LeadReplyInput, reply: ReplyResult) => Promise<void>;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function fetchPendingReplyLeads(maxLeads: number): Promise<LeadReplyInput[]> {
  const { data, error } = await getSupabaseClient()
    .from('leads')
    .select('id, email, gmail_thread_id, contacted_at')
    .in('status', ['contacted', 'follow_up_sent'])
    .not('gmail_thread_id', 'is', null)
    .order('contacted_at', { ascending: true })
    .limit(maxLeads);

  if (error) {
    throw new Error(`Failed to query reply-pending leads: ${error.message}`);
  }

  return (data ?? []) as LeadReplyInput[];
}

/**
 * Writes replied_at before the status RPC so the timestamp is always recorded
 * even if the RPC fails and the job retries on the next poll cycle.
 */
async function persistRepliedFields(leadId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('leads')
    .update({ replied_at: new Date().toISOString() })
    .eq('id', leadId);

  if (error) {
    throw new Error(`Failed to update replied_at for lead ${leadId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Runs one poll pass: queries leads in contacted/follow_up_sent status,
 * checks Gmail for an inbound reply from the lead, and transitions matches
 * to 'replied'.
 *
 * @param onReplyDetected - Optional callback invoked after a successful
 *   transition. Errors from this callback are caught so a notification
 *   failure never blocks the state transition. AVI-22 will inject the
 *   Telegram notifier here.
 */
export async function runReplyDetection(
  onReplyDetected?: ReplyCallback,
): Promise<ReplyDetectionSummary> {
  const maxLeads = getMaxLeads();
  const summary: ReplyDetectionSummary = {
    scanned: 0,
    replied: 0,
    pending: 0,
    failed: 0,
    capped: false,
  };

  await logJob(JOB_TYPE, 'started', {});

  let leads: LeadReplyInput[];
  try {
    leads = await fetchPendingReplyLeads(maxLeads);
  } catch (error) {
    await logJob(JOB_TYPE, 'error', { step: 'fetch_leads', error: serializeError(error) });
    throw error;
  }

  summary.scanned = leads.length;
  summary.capped = leads.length >= maxLeads;

  for (const lead of leads) {
    try {
      const reply = await findReplyForLead(lead);

      if (reply === null) {
        summary.pending += 1;
        continue;
      }

      await persistRepliedFields(lead.id);
      await transitionLeadStatus(lead.id, 'replied', 'system');
      summary.replied += 1;

      if (onReplyDetected) {
        try {
          await onReplyDetected(lead, reply);
        } catch (notifyError) {
          await logJob(JOB_TYPE, 'error', {
            leadId: lead.id,
            step: 'notify',
            error: serializeError(notifyError),
          });
        }
      }
    } catch (error) {
      summary.failed += 1;
      await logJob(JOB_TYPE, 'error', {
        leadId: lead.id,
        step: 'process_lead',
        error: serializeError(error),
      });
    }
  }

  await logJob(JOB_TYPE, 'success', { ...summary });

  return summary;
}
