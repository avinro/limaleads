// AVI-14: Draft job — drains all leads with status='new' and creates Gmail drafts.
//
// Runs after the Apollo poller each cycle. Processes leads in pages of 100
// (oldest first) until the queue is empty, so no 'new' lead is left without a
// draft attempt. Each lead is processed by processLeadDraft, which never throws
// — failures are logged internally and counted here.
//
// Error contract: runDraftJob itself only throws if the Supabase query fails
// (infrastructure error). Individual lead failures are swallowed and tallied.

import { processLeadDraft } from './draftCreator';
import { getSupabaseClient } from '../db/client';
import { serializeError } from '../lib/errors';
import { logJob } from '../lib/logger';

const JOB_TYPE = 'draft-job';
const PAGE_SIZE = 100;

export interface DraftJobSummary {
  scanned: number;
  drafted: number;
  failed: number;
}

/**
 * Fetches one page of lead IDs with status='new', oldest first.
 * Returns an empty array when the queue is drained.
 */
async function fetchNewLeadIds(): Promise<string[]> {
  const { data, error } = await getSupabaseClient()
    .from('leads')
    .select('id')
    .eq('status', 'new')
    .order('created_at', { ascending: true })
    .limit(PAGE_SIZE);

  if (error) {
    throw new Error(`Failed to query new leads: ${error.message}`);
  }

  return (data ?? []).map((row: { id: string }) => row.id);
}

/**
 * Drains the queue of leads with status='new' and creates a Gmail draft for each.
 *
 * Runs in pages of 100 until no leads remain. processLeadDraft handles all
 * per-lead error cases internally and returns null on failure — this job counts
 * successes and failures without rethrowing.
 *
 * Throws only on infrastructure failure (Supabase query error).
 */
export async function runDraftJob(): Promise<DraftJobSummary> {
  const summary: DraftJobSummary = { scanned: 0, drafted: 0, failed: 0 };

  await logJob(JOB_TYPE, 'started', {});

  try {
    let hasMore = true;
    while (hasMore) {
      const ids = await fetchNewLeadIds();

      if (ids.length === 0) {
        hasMore = false;
        break;
      }

      summary.scanned += ids.length;

      for (const id of ids) {
        const result = await processLeadDraft(id);

        if (result !== null) {
          summary.drafted += 1;
        } else {
          summary.failed += 1;
        }
      }
    }

    await logJob(JOB_TYPE, 'success', { ...summary });
  } catch (error) {
    await logJob(JOB_TYPE, 'error', {
      error: serializeError(error),
      summary,
    });

    throw error;
  }

  return summary;
}
