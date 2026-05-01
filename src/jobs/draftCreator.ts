// AVI-18: Gmail draft creator job — Phase 2, Gemini AI generation.
//
// Replaces the static-template path (AVI-13) with a Gemini-generated email.
// Flow:
//   1. Fetch lead row.
//   2. Fetch the first active template.
//   3. Persist template_id on the lead (before calling Gemini, so it is set
//      even when generation fails — required for A/B analysis AC).
//   4. Build LeadContext and call generateEmail.
//   5. Create Gmail draft with the generated subject/body.
//   6. Persist draft IDs and body snapshot.
//   7. Transition lead to draft_created.
//
// Error contract: processLeadDraft never throws. Every failure path:
//   - logs to job_log
//   - sends a best-effort Telegram alert
//   - transitions the lead to generation_failed (unless the lead was not found)
//   - returns null

import { getSupabaseClient } from '../db/client';
import { generateEmail, type LeadContext } from '../integrations/geminiClient';
import { createGmailDraft } from '../integrations/gmailClient';
import { sendTelegramAlert } from '../integrations/telegramNotifier';
import { serializeError } from '../lib/errors';
import { detectLanguageFromCountry } from '../lib/language';
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
  country: string | null;
  company_hook: string | null;
  source_criteria: string | null;
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
// DB helpers
// ---------------------------------------------------------------------------

async function fetchLead(leadId: string): Promise<LeadRow | null> {
  const { data, error } = await getSupabaseClient()
    .from('leads')
    .select('id, email, name, company, title, linkedin_url, country, company_hook, source_criteria')
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

async function persistTemplateId(leadId: string, templateId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('leads')
    .update({ template_id: templateId })
    .eq('id', leadId);

  if (error) {
    throw new Error(`Failed to persist template_id on lead ${leadId}: ${error.message}`);
  }
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
// Alert helper
// ---------------------------------------------------------------------------

/**
 * Sends a best-effort Telegram alert for a generation_failed event.
 * Swallows any Telegram error and logs it to job_log so the alert never
 * blocks the status transition or causes processLeadDraft to rethrow.
 */
async function alertGenerationFailed(leadId: string, step: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const text = `[AVI-18] generation_failed lead=${leadId} step=${step} error=${message}`;

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
 * Creates an AI-personalized Gmail draft for a single lead.
 *
 * Steps:
 *   1. Fetch the lead row.
 *   2. Fetch the first active template.
 *   3. Persist template_id before calling Gemini (satisfies A/B analysis AC even on failure).
 *   4. Build LeadContext and call generateEmail(leadContext, template).
 *   5. Create a Gmail draft with the generated subject and body.
 *   6. Persist draft IDs and body snapshot on the lead row.
 *   7. Transition lead status to draft_created.
 *
 * On any failure (steps 2–7): log to job_log, send Telegram alert, transition
 * to generation_failed, return null without rethrowing.
 * Lead-not-found (step 1): log only, no transition, no alert, return null.
 */
export async function processLeadDraft(leadId: string): Promise<DraftCreatorResult | null> {
  // Step 1: Fetch lead
  let lead: LeadRow | null;
  try {
    lead = await fetchLead(leadId);
  } catch (error) {
    await logJob(JOB_TYPE, 'error', { leadId, step: 'fetch_lead', error: serializeError(error) });
    return null;
  }

  if (!lead) {
    await logJob(JOB_TYPE, 'error', { leadId, step: 'fetch_lead', error: 'Lead not found' });
    return null;
  }

  // Step 2: Fetch active template
  let template: TemplateRow | null;
  try {
    template = await fetchActiveTemplate();
  } catch (error) {
    await logJob(JOB_TYPE, 'error', {
      leadId,
      step: 'fetch_template',
      error: serializeError(error),
    });
    await alertGenerationFailed(leadId, 'fetch_template', error);
    await safeTransitionFailed(leadId);
    return null;
  }

  if (!template) {
    const err = new Error(
      'No active template found — seed one via supabase/migrations or Supabase Studio',
    );
    await logJob(JOB_TYPE, 'error', { leadId, step: 'fetch_template', error: serializeError(err) });
    await alertGenerationFailed(leadId, 'fetch_template', err);
    await safeTransitionFailed(leadId);
    return null;
  }

  // Step 3: Persist template_id before Gemini call
  try {
    await persistTemplateId(leadId, template.id);
  } catch (error) {
    await logJob(JOB_TYPE, 'error', {
      leadId,
      step: 'persist_template_id',
      error: serializeError(error),
    });
    await alertGenerationFailed(leadId, 'persist_template_id', error);
    await safeTransitionFailed(leadId);
    return null;
  }

  // Step 4: Build LeadContext and call Gemini
  const leadContext: LeadContext = {
    name: lead.name,
    title: lead.title,
    company: lead.company,
    linkedinUrl: lead.linkedin_url,
    sourceCriteria: lead.source_criteria,
    country: lead.country,
    language: detectLanguageFromCountry(lead.country),
    companyHook: lead.company_hook,
  };

  let generated: { subject: string; body: string };
  try {
    generated = await generateEmail(leadContext, { body: template.body });
  } catch (error) {
    await logJob(JOB_TYPE, 'error', {
      leadId,
      step: 'generate_email',
      error: serializeError(error),
    });
    await alertGenerationFailed(leadId, 'generate_email', error);
    await safeTransitionFailed(leadId);
    return null;
  }

  // Step 5: Create Gmail draft
  let draftResult: { draftId: string; messageId: string; threadId: string };
  try {
    draftResult = await createGmailDraft({
      to: lead.email,
      subject: generated.subject,
      body: generated.body,
    });
  } catch (error) {
    await logJob(JOB_TYPE, 'error', {
      leadId,
      step: 'create_gmail_draft',
      error: serializeError(error),
    });
    await alertGenerationFailed(leadId, 'create_gmail_draft', error);
    await safeTransitionFailed(leadId);
    return null;
  }

  const { draftId, messageId, threadId } = draftResult;

  // Steps 6–9: Persist and transition — remaining errors fall to outer catch
  try {
    await persistDraftOnLead(leadId, draftId, threadId, generated.subject, generated.body);
    await transitionLeadStatus(leadId, 'draft_created', 'system');
    await logJob(JOB_TYPE, 'success', { leadId, draftId, threadId });

    return { leadId, draftId, messageId, threadId };
  } catch (error) {
    await logJob(JOB_TYPE, 'error', {
      leadId,
      step: 'persist_or_transition',
      error: serializeError(error),
    });
    await alertGenerationFailed(leadId, 'persist_or_transition', error);
    await safeTransitionFailed(leadId);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared failure helper
// ---------------------------------------------------------------------------

/**
 * Attempts to transition the lead to generation_failed.
 * Non-fatal: if the transition itself fails, logs the error and continues.
 */
async function safeTransitionFailed(leadId: string): Promise<void> {
  try {
    await transitionLeadStatus(leadId, 'generation_failed', 'system');
  } catch (statusError) {
    await logJob(JOB_TYPE, 'error', {
      leadId,
      step: 'transition_generation_failed',
      error: serializeError(statusError),
    });
  }
}
