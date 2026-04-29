import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSupabaseClient } from '../db/client';
import { transitionLeadStatus, type LeadStatusEvent } from './leadStatus';

vi.mock('../db/client', () => ({
  getSupabaseClient: vi.fn(),
}));

const MOCK_EVENT: LeadStatusEvent = {
  id: 'evt-uuid',
  lead_id: 'lead-uuid',
  from_status: 'new',
  to_status: 'draft_created',
  actor: 'system',
  reason: null,
  created_at: '2026-04-29T16:00:00Z',
};

function mockRpc(returnValue: { data: unknown; error: null | { message: string } }) {
  const rpc = vi.fn().mockResolvedValue(returnValue);
  vi.mocked(getSupabaseClient).mockReturnValue({ rpc } as never);
  return rpc;
}

describe('transitionLeadStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy path', () => {
    it('calls the RPC with the correct payload and returns the event', async () => {
      const rpc = mockRpc({ data: MOCK_EVENT, error: null });

      const result = await transitionLeadStatus('lead-uuid', 'draft_created', 'system');

      expect(rpc).toHaveBeenCalledWith('transition_lead_status', {
        p_actor: 'system',
        p_lead_id: 'lead-uuid',
        p_reason: null,
        p_to_status: 'draft_created',
      });
      expect(result).toEqual(MOCK_EVENT);
    });

    it('forwards reason to the RPC when provided', async () => {
      const rpc = mockRpc({ data: { ...MOCK_EVENT, reason: 'spam' }, error: null });

      await transitionLeadStatus('lead-uuid', 'disqualified', 'manual', 'spam');

      expect(rpc).toHaveBeenCalledWith(
        'transition_lead_status',
        expect.objectContaining({ p_reason: 'spam' }),
      );
    });

    it('passes p_reason as null when reason is omitted', async () => {
      const rpc = mockRpc({ data: MOCK_EVENT, error: null });

      await transitionLeadStatus('lead-uuid', 'draft_created', 'system');

      expect(rpc).toHaveBeenCalledWith(
        'transition_lead_status',
        expect.objectContaining({ p_reason: null }),
      );
    });
  });

  describe('pre-flight validation (no Supabase call)', () => {
    it('throws before calling Supabase when actor is invalid', async () => {
      const rpc = mockRpc({ data: null, error: null });

      await expect(
        // @ts-expect-error testing invalid runtime value
        transitionLeadStatus('lead-uuid', 'draft_created', 'robot'),
      ).rejects.toThrow('Invalid actor: robot');

      expect(rpc).not.toHaveBeenCalled();
    });

    it('throws before calling Supabase when toStatus is invalid', async () => {
      const rpc = mockRpc({ data: null, error: null });

      await expect(
        // @ts-expect-error testing invalid runtime value
        transitionLeadStatus('lead-uuid', 'flying', 'system'),
      ).rejects.toThrow('Invalid toStatus: flying');

      expect(rpc).not.toHaveBeenCalled();
    });

    it('throws before calling Supabase when actor is manual and reason is missing', async () => {
      const rpc = mockRpc({ data: null, error: null });

      await expect(transitionLeadStatus('lead-uuid', 'disqualified', 'manual')).rejects.toThrow(
        'reason is required for manual transitions',
      );

      expect(rpc).not.toHaveBeenCalled();
    });

    it('throws before calling Supabase when actor is manual and reason is blank', async () => {
      const rpc = mockRpc({ data: null, error: null });

      await expect(
        transitionLeadStatus('lead-uuid', 'disqualified', 'manual', '   '),
      ).rejects.toThrow('reason is required for manual transitions');

      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe('RPC error propagation', () => {
    it('throws when Supabase returns an RPC error', async () => {
      mockRpc({ data: null, error: { message: 'Invalid transition: new -> exhausted' } });

      await expect(transitionLeadStatus('lead-uuid', 'exhausted', 'system')).rejects.toThrow(
        'transition_lead_status RPC failed: Invalid transition: new -> exhausted',
      );
    });
  });
});
