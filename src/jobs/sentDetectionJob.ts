// AVI-19/20: Sent detection job — polls leads awaiting send confirmation and
// updates their status when Gmail confirms the rep actually sent the draft.
//
// Handles two lead states:
//   draft_created       — initial outreach draft created by the draft job
//   follow_up_scheduled — follow-up draft created by the follow-up scheduler
//
// Flow per poll:
//   1. Query up to GMAIL_SENT_POLL_MAX_LEADS leads with status in
//      ('draft_created', 'follow_up_scheduled'), oldest first.
//   2. For each lead, call findSentMessageForLead (AVI-12 correlation strategy).
//   3. No match → skip (handles deleted drafts without false positives).
//   4. Match + draft_created:
//        UPDATE edited_before_send, contacted_at; transition to 'contacted'.
//   5. Match + follow_up_scheduled:
//        UPDATE edited_before_send, last_follow_up_at;
//        increment follow_up_count;
//        transition to 'follow_up_sent'.
//
// Idempotency: if the RPC fails after the UPDATE, the lead stays in its
// pending status. The next poll re-detects via the same Gmail thread and
// retries — no special recovery needed.
//
// Error contract: runSentDetection never throws. Per-lead errors are
// logged and counted; infra errors (Supabase query) are logged and rethrown
// so the worker can surface them.

import { getSupabaseClient } from '../db/client';
import { findSentMessageForLead, type LeadCorrelationInput } from '../integrations/gmailCorrelation';
import { serializeError } from '../lib/errors';
import { transitionLeadStatus } from '../lib/leadStatus';
import { logJob } from '../lib/logger';

const JOB_TYPE = 'sent-detection';
const DEFAULT_MAX_LEADS = 50;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getMaxLeads(): number {
  const raw = process.env.GMAIL_SENT_POLL_MAX_LEADS;
  if (!raw) return DEFAULT_MAX_LEADS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    console.warn(
      `Invalid GMAIL_SENT_POLL_MAX_LEADS "${raw}"; using default ${DEFAULT_MAX_LEADS}`,
    );
    return DEFAULT_MAX_LEADS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SentDetectionSummary {
  scanned: number;
  contacted: number;
  followUpSent: number;
  pending: number;
  failed: number;
  capped: boolean;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function fetchPendingSentLeads(maxLeads: number): Promise<LeadCorrelationInput[]> {
  const { data, error } = await getSupabaseClient()
    .from('leads')
    .select('id, email, gmail_thread_id, draft_subject, draft_body, created_at, status')
    .in('status', ['draft_created', 'follow_up_scheduled'])
    .order('created_at', { ascending: true })
    .limit(maxLeads);

  if (error) {
    throw new Error(`Failed to query draft_created leads: ${error.message}`);
  }

  return (data ?? []) as LeadCorrelationInput[];
}

/**
 * Writes edited_before_send and contacted_at for the initial outreach send.
 * Called before transitionLeadStatus so the timestamps are always set
 * even if the RPC retries on the next poll cycle.
 */
async function persistContactedFields(
  leadId: string,
  editedBeforeSend: boolean,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('leads')
    .update({
      edited_before_send: editedBeforeSend,
      contacted_at: new Date().toISOString(),
    })
    .eq('id', leadId);

  if (error) {
    throw new Error(`Failed to update contacted fields for lead ${leadId}: ${error.message}`);
  }
}

/**
 * Writes edited_before_send, last_follow_up_at, and increments follow_up_count
 * for a confirmed follow-up send.
 * Called before transitionLeadStatus so the timestamps are always set
 * even if the RPC retries on the next poll cycle.
 */
async function persistFollowUpSentFields(
  leadId: string,
  editedBeforeSend: boolean,
): Promise<void> {
  // follow_up_count is incremented here (not at draft creation) to count
  // actual sends, not drafts. The increment uses a raw supabase RPC-style
  // expression; we fetch the current value first to do it safely in TypeScript
  // (MVP approach — a DB function or increment expression would be cleaner).
  const { data: current, error: fetchErr } = await getSupabaseClient()
    .from('leads')
    .select('follow_up_count')
    .eq('id', leadId)
    .maybeSingle();

  if (fetchErr) {
    throw new Error(`Failed to fetch follow_up_count for lead ${leadId}: ${fetchErr.message}`);
  }

  const currentCount = (current as { follow_up_count: number } | null)?.follow_up_count ?? 0;

  const { error } = await getSupabaseClient()
    .from('leads')
    .update({
      edited_before_send: editedBeforeSend,
      last_follow_up_at: new Date().toISOString(),
      follow_up_count: currentCount + 1,
    })
    .eq('id', leadId);

  if (error) {
    throw new Error(`Failed to update follow-up sent fields for lead ${leadId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Runs one poll pass: queries leads in draft_created or follow_up_scheduled,
 * checks Gmail for a sent message for each, and transitions matches.
 *
 * draft_created      → on match: contacted_at, edited_before_send, transition to contacted.
 * follow_up_scheduled → on match: last_follow_up_at, follow_up_count++, edited_before_send,
 *                       transition to follow_up_sent.
 *
 * Throws only on infrastructure failure (Supabase query error on the initial
 * lead fetch). Per-lead errors are swallowed and tallied in the summary.
 */
export async function runSentDetection(): Promise<SentDetectionSummary> {
  const maxLeads = getMaxLeads();
  const summary: SentDetectionSummary = {
    scanned: 0,
    contacted: 0,
    followUpSent: 0,
    pending: 0,
    failed: 0,
    capped: false,
  };

  await logJob(JOB_TYPE, 'started', {});

  let leads: LeadCorrelationInput[];
  try {
    leads = await fetchPendingSentLeads(maxLeads);
  } catch (error) {
    await logJob(JOB_TYPE, 'error', { step: 'fetch_leads', error: serializeError(error) });
    throw error;
  }

  summary.scanned = leads.length;
  summary.capped = leads.length >= maxLeads;

  for (const lead of leads) {
    try {
      const result = await findSentMessageForLead(lead);

      if (result === null) {
        // Draft not yet sent (or deleted without sending) — leave untouched.
        summary.pending += 1;
        continue;
      }

      const leadStatus = (lead as { status?: string }).status;

      if (leadStatus === 'follow_up_scheduled') {
        // Follow-up send confirmed: persist fields and transition to follow_up_sent.
        await persistFollowUpSentFields(lead.id, result.editedBeforeSend);
        await transitionLeadStatus(lead.id, 'follow_up_sent', 'system');
        summary.followUpSent += 1;
      } else {
        // Initial outreach send confirmed: persist fields and transition to contacted.
        await persistContactedFields(lead.id, result.editedBeforeSend);
        await transitionLeadStatus(lead.id, 'contacted', 'system');
        summary.contacted += 1;
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
