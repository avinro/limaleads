import { getSupabaseClient } from '../db/client';
import {
  type ApolloSourceCriteria,
  enrichPerson,
  searchPeople,
} from '../integrations/apolloClient';
import { buildCompanyHook, deriveCountryFromApollo } from '../lib/companyHook';
import { logJob } from '../lib/logger';
import { transitionLeadStatus } from '../lib/leadStatus';
import { runWithRetry } from '../lib/retry';

const JOB_TYPE = 'apollo-poller';
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 2000;
const DEFAULT_PER_PAGE = 100;

export interface PollSummary {
  fetched: number;
  enriched: number;
  created: number;
  duplicates: number;
  skipped: number;
}

function getSourceCriteria(): ApolloSourceCriteria {
  const raw = process.env.APOLLO_SOURCE_CRITERIA;

  if (!raw) {
    throw new Error('Missing required environment variable: APOLLO_SOURCE_CRITERIA');
  }

  try {
    return JSON.parse(raw) as ApolloSourceCriteria;
  } catch {
    throw new Error('APOLLO_SOURCE_CRITERIA is not valid JSON');
  }
}

// ---------------------------------------------------------------------------
// Enrichment fields payload (shared between insert and duplicate update)
// ---------------------------------------------------------------------------

interface EnrichmentFields {
  email: string;
  name: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  apolloId: string;
  sourceCriteria: string;
  // AVI-17 iter 3: Apollo-enriched context fields
  industry: string | null;
  companyDescription: string | null;
  companyKeywords: string[] | null;
  technologyNames: string[] | null;
  headline: string | null;
  departments: string[] | null;
  seniority: string | null;
  companyHook: string | null;
  country: string | null;
  apolloEnrichedAt: string;
}

// ---------------------------------------------------------------------------
// Array safety — Apollo may return null or mixed-type arrays
// ---------------------------------------------------------------------------

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const filtered = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return filtered.length > 0 ? filtered : null;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Insert a single lead row. Returns the new lead's id if inserted, null if it
 * was already present (ON CONFLICT DO NOTHING).
 */
async function insertLead(params: EnrichmentFields): Promise<string | null> {
  const { data, error } = await getSupabaseClient()
    .from('leads')
    .insert({
      email: params.email,
      name: params.name,
      company: params.company,
      title: params.title,
      linkedin_url: params.linkedinUrl,
      apollo_id: params.apolloId,
      source_criteria: params.sourceCriteria,
      country: params.country,
      industry: params.industry,
      company_description: params.companyDescription,
      company_keywords: params.companyKeywords,
      technology_names: params.technologyNames,
      headline: params.headline,
      departments: params.departments,
      seniority: params.seniority,
      company_hook: params.companyHook,
      apollo_enriched_at: params.apolloEnrichedAt,
    })
    .select('id')
    .maybeSingle();

  if (error) {
    // Unique violation (code 23505) means duplicate — treat as expected.
    if ((error as { code?: string }).code === '23505') {
      return null;
    }

    throw new Error(`Failed to insert lead: ${error.message}`);
  }

  return data?.id ?? null;
}

/**
 * Update enrichment columns for an existing lead identified by email.
 *
 * Only updates enrichment fields. Deliberately does NOT touch status,
 * gmail_draft_id, gmail_thread_id, template_id, contacted_at, replied_at,
 * follow_up_count, edited_before_send, created_at, or updated_at (the trigger
 * updates updated_at automatically). This preserves the lead's lifecycle state.
 */
async function updateLeadEnrichment(params: EnrichmentFields): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('leads')
    .update({
      // Keep name/title/linkedin fresh if Apollo returns a better value.
      name: params.name,
      title: params.title,
      linkedin_url: params.linkedinUrl,
      country: params.country,
      industry: params.industry,
      company_description: params.companyDescription,
      company_keywords: params.companyKeywords,
      technology_names: params.technologyNames,
      headline: params.headline,
      departments: params.departments,
      seniority: params.seniority,
      company_hook: params.companyHook,
      apollo_enriched_at: params.apolloEnrichedAt,
    })
    .eq('email', params.email);

  if (error) {
    throw new Error(`Failed to update lead enrichment for ${params.email}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core poller job
// ---------------------------------------------------------------------------

/**
 * Core Apollo poller job.
 *
 * Paginates through Apollo search results, enriches contacts with has_email:true,
 * inserts new leads into Supabase (deduplicating by email), and seeds the audit
 * trail via transitionLeadStatus.
 *
 * For duplicate leads (already in DB), updates enrichment-only columns so the
 * eval script can find rows with company_hook populated.
 *
 * Errors from Apollo API calls are handled by runWithRetry and logged to job_log.
 * The process is never crashed — failures are logged and the job returns a summary.
 *
 * @param maxPages - Optional upper bound on pages fetched. Defaults to Infinity
 *   (fetch all). Set to a low value (e.g. 1) for manual/CLI runs to limit
 *   Apollo credit consumption.
 * @param perPage - Results per page sent to Apollo search. Defaults to
 *   DEFAULT_PER_PAGE (100). Pass a smaller value (e.g. DEMO_DEFAULT_PER_PAGE)
 *   to cap Apollo credit usage during demo runs.
 */
export async function runApolloPoller(
  maxPages = Infinity,
  perPage = DEFAULT_PER_PAGE,
): Promise<PollSummary> {
  const summary: PollSummary = {
    fetched: 0,
    enriched: 0,
    created: 0,
    duplicates: 0,
    skipped: 0,
  };

  await logJob(JOB_TYPE, 'started', {});

  try {
    const criteria = getSourceCriteria();
    const criteriaJson = JSON.stringify(criteria);
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      // Fetch one page of search results — retried on transient errors.
      const searchPage = await runWithRetry(() => searchPeople(criteria, page, perPage), {
        maxAttempts: MAX_ATTEMPTS,
        backoffMs: BACKOFF_MS,
        jobType: JOB_TYPE,
      });

      const { people, pagination } = searchPage;
      summary.fetched += people.length;

      for (const person of people) {
        if (!person.has_email) {
          summary.skipped += 1;
          continue;
        }

        // Enrich to get full contact details — consumes one credit per call.
        let enriched;
        try {
          enriched = await runWithRetry(() => enrichPerson(person.id), {
            maxAttempts: MAX_ATTEMPTS,
            backoffMs: BACKOFF_MS,
            jobType: JOB_TYPE,
          });
        } catch {
          summary.skipped += 1;
          continue;
        }

        if (!enriched) {
          summary.skipped += 1;
          continue;
        }

        summary.enriched += 1;

        // Skip leads missing the required fields for personalization.
        if (!enriched.email) {
          summary.skipped += 1;
          continue;
        }

        if (!enriched.organization?.name) {
          summary.skipped += 1;
          continue;
        }

        const apolloEnrichedAt = new Date().toISOString();
        const companyHook = buildCompanyHook(enriched.organization, enriched);
        const country = deriveCountryFromApollo(enriched.organization, enriched);

        const enrichmentFields: EnrichmentFields = {
          email: enriched.email,
          name: enriched.name,
          company: enriched.organization.name,
          title: enriched.title,
          linkedinUrl: enriched.linkedin_url,
          apolloId: enriched.id,
          sourceCriteria: criteriaJson,
          country,
          industry: enriched.organization.industry ?? null,
          companyDescription: enriched.organization.short_description ?? null,
          companyKeywords: toStringArray(enriched.organization.keywords),
          technologyNames: toStringArray(enriched.organization.technology_names),
          headline: enriched.headline ?? null,
          departments: toStringArray(enriched.departments),
          seniority: enriched.seniority ?? null,
          companyHook,
          apolloEnrichedAt,
        };

        const newLeadId = await insertLead(enrichmentFields);

        if (newLeadId === null) {
          // Email already exists — update enrichment fields only, preserve lifecycle state.
          summary.duplicates += 1;
          try {
            await updateLeadEnrichment(enrichmentFields);
          } catch (updateError) {
            await logJob(JOB_TYPE, 'error', {
              step: 'update_enrichment',
              email: enriched.email,
              error: updateError instanceof Error ? updateError.message : String(updateError),
            });
          }
          continue;
        }

        summary.created += 1;

        // Seed the audit trail: records the initial 'new' status event.
        try {
          await transitionLeadStatus(newLeadId, 'new', 'system');
        } catch (error) {
          // Audit trail failure is non-fatal — the lead row is already committed.
          await logJob(JOB_TYPE, 'error', {
            step: 'seed_status_event',
            leadId: newLeadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Continue only if there are more pages, this page had results, and we
      // have not reached the caller-supplied page cap.
      hasMore = page < pagination.total_pages && people.length > 0 && page < maxPages;
      page += 1;
    }

    await logJob(JOB_TYPE, 'success', { ...summary });
  } catch (error) {
    await logJob(JOB_TYPE, 'error', {
      error: error instanceof Error ? error.message : String(error),
      summary,
    });

    throw error;
  }

  return summary;
}
