import { getSupabaseClient } from '../db/client';
import {
  type ApolloSourceCriteria,
  enrichPerson,
  searchPeople,
} from '../integrations/apolloClient';
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

/**
 * Insert a single lead row. Returns the new lead's id if inserted, null if it
 * was already present (ON CONFLICT DO NOTHING).
 */
async function insertLead(params: {
  email: string;
  name: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  apolloId: string;
  sourceCriteria: string;
}): Promise<string | null> {
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
 * Core Apollo poller job.
 *
 * Paginates through Apollo search results, enriches contacts with has_email:true,
 * inserts new leads into Supabase (deduplicating by email), and seeds the audit
 * trail via transitionLeadStatus.
 *
 * Errors from Apollo API calls are handled by runWithRetry and logged to job_log.
 * The process is never crashed — failures are logged and the job returns a summary.
 *
 * @param maxPages - Optional upper bound on pages fetched. Defaults to Infinity
 *   (fetch all). Set to a low value (e.g. 1) for manual/CLI runs to limit
 *   Apollo credit consumption.
 */
export async function runApolloPoller(maxPages = Infinity): Promise<PollSummary> {
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
      const searchPage = await runWithRetry(() => searchPeople(criteria, page, DEFAULT_PER_PAGE), {
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

        const newLeadId = await insertLead({
          email: enriched.email,
          name: enriched.name,
          company: enriched.organization.name,
          title: enriched.title,
          linkedinUrl: enriched.linkedin_url,
          apolloId: enriched.id,
          sourceCriteria: criteriaJson,
        });

        if (newLeadId === null) {
          // Email already exists in leads — deduplication path.
          summary.duplicates += 1;
          continue;
        }

        summary.created += 1;

        // Seed the audit trail: records the initial 'new' status event.
        // The RPC handles idempotency if a prior attempt inserted the lead but
        // failed before reaching this point.
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
