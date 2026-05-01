// AVI-20: Follow-up scheduler — daily cron that creates Gmail follow-up drafts
// for contacted leads who have not replied within template.follow_up_days.
//
// Flow:
//   1. Query leads in 'contacted' or 'follow_up_sent' whose last relevant
//      timestamp (last_follow_up_at or contacted_at) is older than follow_up_days.
//   2. If follow_up_count >= MAX_FOLLOW_UPS and status='follow_up_sent':
//      transition to 'exhausted' and skip draft creation.
//   3. Otherwise: render follow_up_body with placeholder substitution, create
//      a Gmail draft in the original thread, persist the new draft snapshot,
//      and transition the lead to 'follow_up_scheduled'.
//
// Sent detection (AVI-19/20) confirms the rep actually sent the draft and
// transitions to 'follow_up_sent', incrementing follow_up_count.
//
// Error contract: runFollowUpScheduler never throws. Per-lead errors are
// logged and counted. Infra failures (initial Supabase query) are logged
// and rethrown so the worker can surface them.

import { getSupabaseClient } from '../db/client';
import { createGmailDraft } from '../integrations/gmailClient';
import { sendTelegramAlert } from '../integrations/telegramNotifier';
import { serializeError } from '../lib/errors';
import { transitionLeadStatus } from '../lib/leadStatus';
import { logJob } from '../lib/logger';
import { renderTemplate } from '../lib/templateRenderer';

const JOB_TYPE = 'follow-up-scheduler';
const DEFAULT_MAX_FOLLOW_UPS = 2;
const DEFAULT_MAX_LEADS = 100;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getMaxFollowUps(): number {
  const raw = process.env.MAX_FOLLOW_UPS;
  if (!raw) return DEFAULT_MAX_FOLLOW_UPS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    console.warn(`Invalid MAX_FOLLOW_UPS "${raw}"; using default ${DEFAULT_MAX_FOLLOW_UPS}`);
    return DEFAULT_MAX_FOLLOW_UPS;
  }
  return parsed;
}

function getMaxLeads(): number {
  const raw = process.env.FOLLOW_UP_MAX_LEADS;
  if (!raw) return DEFAULT_MAX_LEADS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    console.warn(`Invalid FOLLOW_UP_MAX_LEADS "${raw}"; using default ${DEFAULT_MAX_LEADS}`);
    return DEFAULT_MAX_LEADS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FollowUpSummary {
  scanned: number;
  drafted: number;
  exhausted: number;
  skipped: number;
  failed: number;
}

interface EligibleLead {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  title: string | null;
  linkedin_url: string | null;
  status: string;
  follow_up_count: number;
  contacted_at: string | null;
  last_follow_up_at: string | null;
  gmail_thread_id: string;
  draft_subject: string | null;
  draft_body: string;
  follow_up_body: string;
  follow_up_days: number;
  template_id: string;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function fetchEligibleLeads(maxLeads: number): Promise<EligibleLead[]> {
  // Raw SQL via rpc is not available through the JS client without a stored
  // procedure, so we use a two-step approach:
  //   1. Select eligible leads with a join-style filter on template fields.
  //   2. The follow_up_days threshold is enforced here in TypeScript after
  //      fetching, because the Supabase JS client does not support joining
  //      and filtering on joined-table columns directly.
  //
  // For MVP with O(100) leads per run this is acceptable. A stored proc
  // or raw SQL via rpc can replace this in a future issue.
  const { data, error } = await getSupabaseClient()
    .from('leads')
    .select(
      `id, email, name, company, title, linkedin_url, status,
       follow_up_count, contacted_at, last_follow_up_at,
       gmail_thread_id, draft_subject, draft_body,
       templates!inner(id, follow_up_body, follow_up_days)`,
    )
    .in('status', ['contacted', 'follow_up_sent'])
    .not('gmail_thread_id', 'is', null)
    .not('draft_body', 'is', null)
    .not('template_id', 'is', null)
    .order('contacted_at', { ascending: true })
    .limit(maxLeads * 3); // Fetch extra to account for threshold filtering below

  if (error) {
    throw new Error(`Failed to query eligible follow-up leads: ${error.message}`);
  }

  // Cast via unknown because the Supabase JS client types `templates!inner(...)`
  // as an array in the inferred type, even though the scalar join returns a
  // single object. The explicit cast is safe: the row is either a single object
  // (inner join, guaranteed by `!inner`) or null (no row), never an array.
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    email: string;
    name: string | null;
    company: string | null;
    title: string | null;
    linkedin_url: string | null;
    status: string;
    follow_up_count: number;
    contacted_at: string | null;
    last_follow_up_at: string | null;
    gmail_thread_id: string;
    draft_subject: string | null;
    draft_body: string;
    templates: { id: string; follow_up_body: string | null; follow_up_days: number } | null;
  }>;

  const now = Date.now();
  const eligible: EligibleLead[] = [];

  for (const row of rows) {
    const tmpl = row.templates;
    if (!tmpl || !tmpl.follow_up_body) continue;

    // Compute the reference timestamp: last follow-up sent time or first contact time.
    const refIso = row.last_follow_up_at ?? row.contacted_at;
    if (!refIso) continue;

    const refMs = new Date(refIso).getTime();
    const thresholdMs = tmpl.follow_up_days * 24 * 60 * 60 * 1000;

    if (now - refMs < thresholdMs) continue;

    eligible.push({
      id: row.id,
      email: row.email,
      name: row.name,
      company: row.company,
      title: row.title,
      linkedin_url: row.linkedin_url,
      status: row.status,
      follow_up_count: row.follow_up_count,
      contacted_at: row.contacted_at,
      last_follow_up_at: row.last_follow_up_at,
      gmail_thread_id: row.gmail_thread_id,
      draft_subject: row.draft_subject,
      draft_body: row.draft_body,
      follow_up_body: tmpl.follow_up_body,
      follow_up_days: tmpl.follow_up_days,
      template_id: tmpl.id,
    });

    if (eligible.length >= maxLeads) break;
  }

  return eligible;
}

async function persistFollowUpDraft(
  leadId: string,
  draftId: string,
  threadId: string,
  subject: string,
  body: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('leads')
    .update({
      gmail_draft_id: draftId,
      gmail_thread_id: threadId,
      draft_subject: subject,
      draft_body: body,
    })
    .eq('id', leadId);

  if (error) {
    throw new Error(`Failed to persist follow-up draft on lead ${leadId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Alert helper
// ---------------------------------------------------------------------------

async function alertFollowUpFailed(leadId: string, step: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const text = `[AVI-20] follow_up_failed lead=${leadId} step=${step} error=${message}`;

  try {
    await sendTelegramAlert(text);
  } catch (alertError) {
    await logJob(JOB_TYPE, 'error', {
      leadId,
      step: 'telegram_alert_failed',
      error: serializeError(alertError),
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Runs one scheduling pass: queries eligible leads and creates follow-up
 * Gmail drafts for each. Transitions leads to 'follow_up_scheduled'.
 * Leads with follow_up_count >= MAX_FOLLOW_UPS are transitioned to 'exhausted'.
 *
 * Throws only on infrastructure failure (initial Supabase query).
 * Per-lead errors are swallowed, logged, and tallied.
 */
export async function runFollowUpScheduler(): Promise<FollowUpSummary> {
  const maxLeads = getMaxLeads();
  const maxFollowUps = getMaxFollowUps();

  const summary: FollowUpSummary = {
    scanned: 0,
    drafted: 0,
    exhausted: 0,
    skipped: 0,
    failed: 0,
  };

  await logJob(JOB_TYPE, 'started', {});

  let leads: EligibleLead[];
  try {
    leads = await fetchEligibleLeads(maxLeads);
  } catch (error) {
    await logJob(JOB_TYPE, 'error', { step: 'fetch_leads', error: serializeError(error) });
    throw error;
  }

  summary.scanned = leads.length;

  for (const lead of leads) {
    // --- Exhaustion check ---
    if (lead.follow_up_count >= maxFollowUps) {
      if (lead.status === 'follow_up_sent') {
        try {
          await transitionLeadStatus(lead.id, 'exhausted', 'system');
          summary.exhausted += 1;
        } catch (error) {
          summary.failed += 1;
          await logJob(JOB_TYPE, 'error', {
            leadId: lead.id,
            step: 'transition_exhausted',
            error: serializeError(error),
          });
        }
      } else {
        // contacted with follow_up_count >= max is invalid data; log and skip.
        summary.skipped += 1;
        await logJob(JOB_TYPE, 'error', {
          leadId: lead.id,
          step: 'skipped_invalid_exhaustion_state',
          status: lead.status,
          follow_up_count: lead.follow_up_count,
        });
      }
      continue;
    }

    // --- Draft creation ---
    const body = renderTemplate(lead.follow_up_body, {
      name: lead.name,
      company: lead.company,
      title: lead.title,
      linkedin_url: lead.linkedin_url,
    });
    const subject = `Re: ${lead.draft_subject ?? '(no subject)'}`;

    let draftResult: { draftId: string; messageId: string; threadId: string };
    try {
      draftResult = await createGmailDraft({
        to: lead.email,
        subject,
        body,
        threadId: lead.gmail_thread_id,
      });
    } catch (error) {
      summary.failed += 1;
      await logJob(JOB_TYPE, 'error', {
        leadId: lead.id,
        step: 'create_gmail_draft',
        error: serializeError(error),
      });
      await alertFollowUpFailed(lead.id, 'create_gmail_draft', error);
      continue;
    }

    // --- Persist draft snapshot + transition ---
    try {
      await persistFollowUpDraft(lead.id, draftResult.draftId, draftResult.threadId, subject, body);
      await transitionLeadStatus(lead.id, 'follow_up_scheduled', 'system');
      summary.drafted += 1;
      await logJob(JOB_TYPE, 'success', {
        leadId: lead.id,
        draftId: draftResult.draftId,
        threadId: draftResult.threadId,
      });
    } catch (error) {
      summary.failed += 1;
      await logJob(JOB_TYPE, 'error', {
        leadId: lead.id,
        step: 'persist_or_transition',
        error: serializeError(error),
      });
      await alertFollowUpFailed(lead.id, 'persist_or_transition', error);
    }
  }

  await logJob(JOB_TYPE, 'success', { ...summary });

  return summary;
}
