// AVI-13: Gmail draft creator job.
//
// Reads the first active template from Supabase, substitutes lead placeholders,
// creates a Gmail draft, snapshots subject/body for edit-detection (AVI-19),
// and transitions the lead to draft_created.
//
// Error contract: processLeadDraft never throws — failures are logged to
// job_log and the lead transitions to generation_failed instead.

import { getSupabaseClient } from '../db/client';
import { createGmailDraft } from '../integrations/gmailClient';
import { serializeError } from '../lib/errors';
import { transitionLeadStatus } from '../lib/leadStatus';
import { logJob } from '../lib/logger';

const JOB_TYPE = 'draft-creator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LeadRow {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  title: string | null;
  linkedin_url: string | null;
  // AVI-17: additive enrichment fields. AVI-18 will wire these into generateEmail.
  country: string | null;
  company_hook: string | null;
}

interface TemplateRow {
  id: string;
  subject: string;
  body: string;
}

export interface DraftCreatorResult {
  leadId: string;
  draftId: string;
  messageId: string;
  threadId: string;
}

// ---------------------------------------------------------------------------
// Placeholder substitution
// ---------------------------------------------------------------------------

/**
 * Replaces {{name}}, {{company}}, {{title}}, and {{linkedin_url}} placeholders
 * in an email template string with actual lead data.
 * Missing lead fields are replaced with an empty string.
 */
function applyPlaceholders(text: string, lead: LeadRow): string {
  return text
    .replace(/\{\{name\}\}/g, lead.name ?? '')
    .replace(/\{\{company\}\}/g, lead.company ?? '')
    .replace(/\{\{title\}\}/g, lead.title ?? '')
    .replace(/\{\{linkedin_url\}\}/g, lead.linkedin_url ?? '');
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function fetchLead(leadId: string): Promise<LeadRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('leads')
    .select('id, email, name, company, title, linkedin_url, country, company_hook')
    .eq('id', leadId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch lead ${leadId}: ${error.message}`);
  }

  return data;
}

async function fetchActiveTemplate(): Promise<TemplateRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('templates')
    .select('id, subject, body')
    .eq('active', true)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch active template: ${error.message}`);
  }

  return data;
}

async function persistDraftOnLead(
  leadId: string,
  draftId: string,
  threadId: string,
  draftSubject: string,
  draftBody: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('leads')
    .update({
      gmail_draft_id: draftId,
      gmail_thread_id: threadId,
      // Snapshot stored for AVI-19 (sent detector) to detect rep edits.
      draft_subject: draftSubject,
      draft_body: draftBody,
    })
    .eq('id', leadId);

  if (error) {
    throw new Error(`Failed to update lead ${leadId} with draft info: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Creates a Gmail draft for a single lead.
 *
 * Steps:
 *   1. Fetch the lead row.
 *   2. Fetch the first active template.
 *   3. Substitute placeholders in subject and body.
 *   4. Create a Gmail draft via the API.
 *   5. Persist draft IDs and body snapshot on the lead row.
 *   6. Transition the lead status to draft_created.
 *
 * On any failure: logs to job_log, transitions lead to generation_failed,
 * returns null without rethrowing.
 */
export async function processLeadDraft(leadId: string): Promise<DraftCreatorResult | null> {
  try {
    const lead = await fetchLead(leadId);

    if (!lead) {
      await logJob(JOB_TYPE, 'error', {
        leadId,
        step: 'fetch_lead',
        error: 'Lead not found',
      });
      return null;
    }

    const template = await fetchActiveTemplate();

    if (!template) {
      await logJob(JOB_TYPE, 'error', {
        leadId,
        step: 'fetch_template',
        error: 'No active template found — seed one via supabase/migrations or Supabase Studio',
      });
      await transitionLeadStatus(leadId, 'generation_failed', 'system');
      return null;
    }

    const subject = applyPlaceholders(template.subject, lead);
    const body = applyPlaceholders(template.body, lead);

    const { draftId, messageId, threadId } = await createGmailDraft({
      to: lead.email,
      subject,
      body,
    });

    await persistDraftOnLead(leadId, draftId, threadId, subject, body);
    await transitionLeadStatus(leadId, 'draft_created', 'system');
    await logJob(JOB_TYPE, 'success', { leadId, draftId, threadId });

    return { leadId, draftId, messageId, threadId };
  } catch (error) {
    await logJob(JOB_TYPE, 'error', {
      leadId,
      error: serializeError(error),
    });

    try {
      await transitionLeadStatus(leadId, 'generation_failed', 'system');
    } catch (statusError) {
      // Status transition failure is non-fatal — the job_log entry above already captures the root error.
      await logJob(JOB_TYPE, 'error', {
        leadId,
        step: 'transition_generation_failed',
        error: serializeError(statusError),
      });
    }

    return null;
  }
}
