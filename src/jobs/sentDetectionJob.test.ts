import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('../db/client', () => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock('../integrations/gmailCorrelation', () => ({
  findSentMessageForLead: vi.fn(),
}));

vi.mock('../lib/leadStatus', () => ({
  transitionLeadStatus: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  logJob: vi.fn().mockResolvedValue(undefined),
}));

import { getSupabaseClient } from '../db/client';
import { findSentMessageForLead } from '../integrations/gmailCorrelation';
import { transitionLeadStatus } from '../lib/leadStatus';
import { logJob } from '../lib/logger';
import { runSentDetection } from './sentDetectionJob';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_LEAD = {
  id: 'lead-uuid-1',
  email: 'lead@acme.com',
  gmail_thread_id: 'thread-abc',
  draft_subject: 'Hello from LimaLeads',
  draft_body: 'Hi there, reaching out about Acme.',
  created_at: new Date(1_000_000).toISOString(),
};

const SENT_RESULT = {
  messageId: 'msg-sent-1',
  threadId: 'thread-abc',
  sentAt: new Date(2_000_000),
  body: 'Hi there, reaching out about Acme.',
  editedBeforeSend: false,
};

const SENT_RESULT_EDITED = {
  ...SENT_RESULT,
  body: 'Hi there, I edited this before sending.',
  editedBeforeSend: true,
};

// ---------------------------------------------------------------------------
// Supabase mock helpers
// ---------------------------------------------------------------------------

/**
 * Builds a Supabase mock whose from('leads').select().eq().order().limit()
 * chain resolves with the given data for queries, and whose update().eq()
 * chain resolves with { error: null } for writes.
 */
function makeSupabaseMock(leads: typeof BASE_LEAD[]): void {
  const limit = vi.fn().mockResolvedValue({ data: leads, error: null });
  const order = vi.fn().mockReturnValue({ limit });
  const eqSelect = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ eqSelect, eq: eqSelect });

  const eqUpdate = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn().mockReturnValue({ eq: eqUpdate });

  const from = vi.fn().mockReturnValue({ select, update });

  vi.mocked(getSupabaseClient).mockReturnValue({ from } as never);
}

/**
 * Like makeSupabaseMock but makes the update call return an error.
 */
function makeSupabaseMockWithUpdateError(leads: typeof BASE_LEAD[], errorMsg: string): void {
  const limit = vi.fn().mockResolvedValue({ data: leads, error: null });
  const order = vi.fn().mockReturnValue({ limit });
  const eqSelect = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ eqSelect, eq: eqSelect });

  const eqUpdate = vi.fn().mockResolvedValue({ error: { message: errorMsg } });
  const update = vi.fn().mockReturnValue({ eq: eqUpdate });

  const from = vi.fn().mockReturnValue({ select, update });

  vi.mocked(getSupabaseClient).mockReturnValue({ from } as never);
}

/**
 * Makes the initial lead fetch fail with a DB error.
 */
function makeSupabaseMockWithFetchError(errorMsg: string): void {
  const limit = vi.fn().mockResolvedValue({ data: null, error: { message: errorMsg } });
  const order = vi.fn().mockReturnValue({ limit });
  const eqSelect = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ eqSelect, eq: eqSelect });
  const from = vi.fn().mockReturnValue({ select });

  vi.mocked(getSupabaseClient).mockReturnValue({ from } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSentDetection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Happy path ─────────────────────────────────────────────────────────

  describe('happy path — match found', () => {
    it('writes edited_before_send=false, contacted_at, and transitions to contacted', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findSentMessageForLead).mockResolvedValueOnce(SENT_RESULT);
      vi.mocked(transitionLeadStatus).mockResolvedValueOnce({} as never);

      const summary = await runSentDetection();

      expect(summary).toEqual({
        scanned: 1,
        contacted: 1,
        pending: 0,
        failed: 0,
        capped: false,
      });

      // UPDATE must carry both fields
      const { from } = vi.mocked(getSupabaseClient).mock.results[0]!.value as {
        from: ReturnType<typeof vi.fn>;
      };
      const updateCall = from.mock.results[0]!.value.update.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(updateCall.edited_before_send).toBe(false);
      expect(typeof updateCall.contacted_at).toBe('string');

      expect(transitionLeadStatus).toHaveBeenCalledWith(BASE_LEAD.id, 'contacted', 'system');
    });

    it('writes edited_before_send=true when the rep edited the draft before sending', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findSentMessageForLead).mockResolvedValueOnce(SENT_RESULT_EDITED);
      vi.mocked(transitionLeadStatus).mockResolvedValueOnce({} as never);

      await runSentDetection();

      const { from } = vi.mocked(getSupabaseClient).mock.results[0]!.value as {
        from: ReturnType<typeof vi.fn>;
      };
      const updateCall = from.mock.results[0]!.value.update.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(updateCall.edited_before_send).toBe(true);
    });
  });

  // ─── No match ───────────────────────────────────────────────────────────

  describe('no match', () => {
    it('skips lead when findSentMessageForLead returns null (draft not yet sent)', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findSentMessageForLead).mockResolvedValueOnce(null);

      const summary = await runSentDetection();

      expect(summary.pending).toBe(1);
      expect(summary.contacted).toBe(0);
      expect(transitionLeadStatus).not.toHaveBeenCalled();
    });

    it('returns empty summary when there are no draft_created leads', async () => {
      makeSupabaseMock([]);

      const summary = await runSentDetection();

      expect(summary).toEqual({
        scanned: 0,
        contacted: 0,
        pending: 0,
        failed: 0,
        capped: false,
      });
      expect(findSentMessageForLead).not.toHaveBeenCalled();
    });
  });

  // ─── Per-lead errors ─────────────────────────────────────────────────────

  describe('per-lead error handling', () => {
    it('counts failed and continues when findSentMessageForLead throws', async () => {
      const lead2 = { ...BASE_LEAD, id: 'lead-uuid-2' };
      makeSupabaseMock([BASE_LEAD, lead2]);

      vi.mocked(findSentMessageForLead)
        .mockRejectedValueOnce(new Error('Gmail 503'))
        .mockResolvedValueOnce(SENT_RESULT);
      vi.mocked(transitionLeadStatus).mockResolvedValueOnce({} as never);

      const summary = await runSentDetection();

      expect(summary.failed).toBe(1);
      expect(summary.contacted).toBe(1);
      expect(summary.scanned).toBe(2);
    });

    it('logs error details when a per-lead error occurs', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findSentMessageForLead).mockRejectedValueOnce(new Error('Gmail 503'));

      await runSentDetection();

      const errorCall = vi.mocked(logJob).mock.calls.find((c) => c[1] === 'error');
      expect(errorCall).toBeDefined();
      expect(errorCall![2]).toMatchObject({ leadId: BASE_LEAD.id, step: 'process_lead' });
    });

    it('counts failed when persistContactedFields (UPDATE) throws, and does not call transition', async () => {
      makeSupabaseMockWithUpdateError([BASE_LEAD], 'DB write failed');
      vi.mocked(findSentMessageForLead).mockResolvedValueOnce(SENT_RESULT);

      const summary = await runSentDetection();

      expect(summary.failed).toBe(1);
      expect(summary.contacted).toBe(0);
      expect(transitionLeadStatus).not.toHaveBeenCalled();
    });

    it('counts failed when transitionLeadStatus throws after UPDATE succeeds', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findSentMessageForLead).mockResolvedValueOnce(SENT_RESULT);
      vi.mocked(transitionLeadStatus).mockRejectedValueOnce(
        new Error('RPC error: invalid transition'),
      );

      const summary = await runSentDetection();

      // UPDATE was called (lead stays in draft_created — recoverable on next poll)
      const { from } = vi.mocked(getSupabaseClient).mock.results[0]!.value as {
        from: ReturnType<typeof vi.fn>;
      };
      expect(from.mock.results[0]!.value.update).toHaveBeenCalled();
      expect(summary.failed).toBe(1);
      expect(summary.contacted).toBe(0);
    });
  });

  // ─── Scan cap ────────────────────────────────────────────────────────────

  describe('scan cap', () => {
    it('sets capped=true when scanned count equals GMAIL_SENT_POLL_MAX_LEADS', async () => {
      // Default max is 50; simulate exactly 50 leads returned
      const fiftyLeads = Array.from({ length: 50 }, (_, i) => ({
        ...BASE_LEAD,
        id: `lead-${i}`,
      }));

      makeSupabaseMock(fiftyLeads);
      vi.mocked(findSentMessageForLead).mockResolvedValue(null);

      const summary = await runSentDetection();

      expect(summary.capped).toBe(true);
      expect(summary.scanned).toBe(50);
    });

    it('sets capped=false when fewer leads than the cap are returned', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findSentMessageForLead).mockResolvedValueOnce(null);

      const summary = await runSentDetection();

      expect(summary.capped).toBe(false);
    });
  });

  // ─── Logging ─────────────────────────────────────────────────────────────

  describe('logging', () => {
    it('logs started then success on a clean run', async () => {
      makeSupabaseMock([]);

      await runSentDetection();

      expect(logJob).toHaveBeenCalledWith('sent-detection', 'started', {});
      expect(logJob).toHaveBeenCalledWith(
        'sent-detection',
        'success',
        expect.objectContaining({ scanned: 0, contacted: 0, pending: 0, failed: 0 }),
      );
    });

    it('logs error and rethrows when the Supabase lead fetch fails', async () => {
      makeSupabaseMockWithFetchError('connection timeout');

      await expect(runSentDetection()).rejects.toThrow(
        'Failed to query draft_created leads: connection timeout',
      );

      expect(logJob).toHaveBeenCalledWith(
        'sent-detection',
        'error',
        expect.objectContaining({ step: 'fetch_leads' }),
      );
    });
  });
});
