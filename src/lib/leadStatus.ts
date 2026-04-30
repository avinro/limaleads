import { getSupabaseClient } from '../db/client';

export type LeadStatus =
  | 'new'
  | 'draft_created'
  | 'generation_failed'
  | 'contacted'
  | 'replied'
  | 'follow_up_scheduled'
  | 'follow_up_sent'
  | 'exhausted'
  | 'closed_won'
  | 'closed_lost'
  | 'disqualified';

export type LeadStatusActor = 'system' | 'manual' | 'override';

export interface LeadStatusEvent {
  id: string;
  lead_id: string;
  from_status: string | null;
  to_status: string;
  actor: LeadStatusActor;
  reason: string | null;
  created_at: string;
}

const VALID_STATUSES = new Set<string>([
  'new',
  'draft_created',
  'generation_failed',
  'contacted',
  'replied',
  'follow_up_scheduled',
  'follow_up_sent',
  'exhausted',
  'closed_won',
  'closed_lost',
  'disqualified',
]);

const VALID_ACTORS = new Set<string>(['system', 'manual', 'override']);

/**
 * Transitions a lead to a new status by calling the transactional DB RPC.
 * The SQL function owns transition validity and audit atomicity — this wrapper
 * only validates the caller contract TypeScript can check before a round-trip.
 *
 * Throws for:
 *   - Invalid toStatus or actor values (caught before calling Supabase)
 *   - actor='manual' with missing/blank reason (caught before calling Supabase)
 *   - Any RPC error returned by Supabase (invalid transition, lead not found, etc.)
 */
export async function transitionLeadStatus(
  leadId: string,
  toStatus: LeadStatus,
  actor: LeadStatusActor,
  reason?: string,
): Promise<LeadStatusEvent> {
  if (!VALID_STATUSES.has(toStatus)) {
    throw new Error(`Invalid toStatus: ${toStatus}`);
  }

  if (!VALID_ACTORS.has(actor)) {
    throw new Error(`Invalid actor: ${actor}`);
  }

  if (actor === 'manual' && (!reason || reason.trim() === '')) {
    throw new Error('reason is required for manual transitions');
  }

  const { data, error } = await getSupabaseClient().rpc('transition_lead_status', {
    p_actor: actor,
    p_lead_id: leadId,
    p_reason: reason ?? null,
    p_to_status: toStatus,
  });

  if (error) {
    throw new Error(`transition_lead_status RPC failed: ${error.message}`);
  }

  return data as LeadStatusEvent;
}
