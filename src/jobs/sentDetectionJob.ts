// AVI-19: Sent detection job — polls `draft_created` leads and marks them
// `contacted` when Gmail confirms the draft was sent by the rep.
//
// Flow per poll:
//   1. Query up to GMAIL_SENT_POLL_MAX_LEADS leads with status='draft_created',
//      oldest first.
//   2. For each lead, call findSentMessageForLead (AVI-12 correlation strategy).
//   3. No match → skip (handles deleted drafts without false positives).
//   4. Match → UPDATE leads SET edited_before_send, contacted_at; then
//      transitionLeadStatus to 'contacted'.
//
// Idempotency: if the RPC fails after the UPDATE, the lead stays in
// 'draft_created' with a stale contacted_at. The next poll re-detects via
// the same Gmail thread and retries — no special recovery needed.
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
  pending: number;
  failed: number;
  capped: boolean;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function fetchDraftCreatedLeads(maxLeads: number): Promise<LeadCorrelationInput[]> {
  const { data, error } = await getSupabaseClient()
    .from('leads')
    .select('id, email, gmail_thread_id, draft_subject, draft_body, created_at')
    .eq('status', 'draft_created')
    .order('created_at', { ascending: true })
    .limit(maxLeads);

  if (error) {
    throw new Error(`Failed to query draft_created leads: ${error.message}`);
  }

  return (data ?? []) as LeadCorrelationInput[];
}

/**
 * Writes both edited_before_send and contacted_at in a single UPDATE.
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Runs one poll pass: queries up to maxLeads draft_created leads, checks
 * Gmail for a sent message for each, and transitions matches to contacted.
 *
 * Throws only on infrastructure failure (Supabase query error on the initial
 * lead fetch). Per-lead errors are swallowed and tallied in the summary.
 */
export async function runSentDetection(): Promise<SentDetectionSummary> {
  const maxLeads = getMaxLeads();
  const summary: SentDetectionSummary = {
    scanned: 0,
    contacted: 0,
    pending: 0,
    failed: 0,
    capped: false,
  };

  await logJob(JOB_TYPE, 'started', {});

  let leads: LeadCorrelationInput[];
  try {
    leads = await fetchDraftCreatedLeads(maxLeads);
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

      // Write edited_before_send and contacted_at before transitioning status.
      await persistContactedFields(lead.id, result.editedBeforeSend);
      await transitionLeadStatus(lead.id, 'contacted', 'system');
      summary.contacted += 1;
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
