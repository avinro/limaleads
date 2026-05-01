import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('../db/client', () => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock('../integrations/gmailReply', () => ({
  findReplyForLead: vi.fn(),
}));

vi.mock('../lib/leadStatus', () => ({
  transitionLeadStatus: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  logJob: vi.fn().mockResolvedValue(undefined),
}));

import { getSupabaseClient } from '../db/client';
import { findReplyForLead } from '../integrations/gmailReply';
import { transitionLeadStatus } from '../lib/leadStatus';
import { logJob } from '../lib/logger';
import { runReplyDetection } from './replyDetectionJob';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_LEAD = {
  id: 'lead-uuid-1',
  email: 'lead@acme.com',
  gmail_thread_id: 'thread-abc',
  contacted_at: new Date(1_000_000).toISOString(),
};

const REPLY_RESULT = {
  messageId: 'msg-reply-1',
  threadId: 'thread-abc',
  repliedAt: new Date(2_000_000),
  fromAddress: 'lead@acme.com',
};

// ---------------------------------------------------------------------------
// Supabase mock helpers
// ---------------------------------------------------------------------------

/**
 * Builds a Supabase mock whose from('leads').select().in().not().order().limit()
 * chain resolves with the given data, and whose update().eq() chain resolves
 * for writes.
 */
function makeSupabaseMock(leads: (typeof BASE_LEAD)[]): void {
  const limit = vi.fn().mockResolvedValue({ data: leads, error: null });
  const order = vi.fn().mockReturnValue({ limit });
  const not = vi.fn().mockReturnValue({ order });
  const inFilter = vi.fn().mockReturnValue({ not });
  const select = vi.fn().mockReturnValue({ in: inFilter });

  const eqUpdate = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn().mockReturnValue({ eq: eqUpdate });

  const from = vi.fn().mockReturnValue({ select, update });

  vi.mocked(getSupabaseClient).mockReturnValue({ from } as never);
}

/**
 * Like makeSupabaseMock but makes the update call return an error.
 */
function makeSupabaseMockWithUpdateError(
  leads: (typeof BASE_LEAD)[],
  errorMsg: string,
): void {
  const limit = vi.fn().mockResolvedValue({ data: leads, error: null });
  const order = vi.fn().mockReturnValue({ limit });
  const not = vi.fn().mockReturnValue({ order });
  const inFilter = vi.fn().mockReturnValue({ not });
  const select = vi.fn().mockReturnValue({ in: inFilter });

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
  const not = vi.fn().mockReturnValue({ order });
  const inFilter = vi.fn().mockReturnValue({ not });
  const select = vi.fn().mockReturnValue({ in: inFilter });
  const from = vi.fn().mockReturnValue({ select });

  vi.mocked(getSupabaseClient).mockReturnValue({ from } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runReplyDetection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  describe('happy path — reply found', () => {
    it('sets replied_at, transitions to replied, and returns correct summary', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findReplyForLead).mockResolvedValueOnce(REPLY_RESULT);
      vi.mocked(transitionLeadStatus).mockResolvedValueOnce({} as never);

      const summary = await runReplyDetection();

      expect(summary).toEqual({
        scanned: 1,
        replied: 1,
        pending: 0,
        failed: 0,
        capped: false,
      });

      // replied_at UPDATE must have been called
      const { from } = vi.mocked(getSupabaseClient).mock.results[0]!.value as {
        from: ReturnType<typeof vi.fn>;
      };
      const updateCall = from.mock.results[0]!.value.update.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(typeof updateCall.replied_at).toBe('string');

      expect(transitionLeadStatus).toHaveBeenCalledWith(BASE_LEAD.id, 'replied', 'system');
    });

    it('calls onReplyDetected callback after a successful transition', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findReplyForLead).mockResolvedValueOnce(REPLY_RESULT);
      vi.mocked(transitionLeadStatus).mockResolvedValueOnce({} as never);

      const onReplyDetected = vi.fn().mockResolvedValue(undefined);
      await runReplyDetection(onReplyDetected);

      expect(onReplyDetected).toHaveBeenCalledWith(BASE_LEAD, REPLY_RESULT);
    });

    it('does NOT call onReplyDetected when no reply is found', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findReplyForLead).mockResolvedValueOnce(null);

      const onReplyDetected = vi.fn();
      await runReplyDetection(onReplyDetected);

      expect(onReplyDetected).not.toHaveBeenCalled();
    });
  });

  // ─── No match ────────────────────────────────────────────────────────────

  describe('no match', () => {
    it('skips lead when findReplyForLead returns null', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findReplyForLead).mockResolvedValueOnce(null);

      const summary = await runReplyDetection();

      expect(summary.pending).toBe(1);
      expect(summary.replied).toBe(0);
      expect(transitionLeadStatus).not.toHaveBeenCalled();
    });

    it('returns empty summary when there are no pending leads', async () => {
      makeSupabaseMock([]);

      const summary = await runReplyDetection();

      expect(summary).toEqual({
        scanned: 0,
        replied: 0,
        pending: 0,
        failed: 0,
        capped: false,
      });
      expect(findReplyForLead).not.toHaveBeenCalled();
    });
  });

  // ─── Per-lead error handling ──────────────────────────────────────────────

  describe('per-lead error handling', () => {
    it('counts failed and continues when findReplyForLead throws', async () => {
      const lead2 = { ...BASE_LEAD, id: 'lead-uuid-2' };
      makeSupabaseMock([BASE_LEAD, lead2]);

      vi.mocked(findReplyForLead)
        .mockRejectedValueOnce(new Error('Gmail 503'))
        .mockResolvedValueOnce(REPLY_RESULT);
      vi.mocked(transitionLeadStatus).mockResolvedValueOnce({} as never);

      const summary = await runReplyDetection();

      expect(summary.failed).toBe(1);
      expect(summary.replied).toBe(1);
      expect(summary.scanned).toBe(2);
    });

    it('logs error details when a per-lead error occurs', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findReplyForLead).mockRejectedValueOnce(new Error('Gmail 503'));

      await runReplyDetection();

      const errorCall = vi.mocked(logJob).mock.calls.find((c) => c[1] === 'error');
      expect(errorCall).toBeDefined();
      expect(errorCall![2]).toMatchObject({ leadId: BASE_LEAD.id, step: 'process_lead' });
    });

    it('counts failed when persistRepliedFields (UPDATE) throws, does not call transition', async () => {
      makeSupabaseMockWithUpdateError([BASE_LEAD], 'DB write failed');
      vi.mocked(findReplyForLead).mockResolvedValueOnce(REPLY_RESULT);

      const summary = await runReplyDetection();

      expect(summary.failed).toBe(1);
      expect(summary.replied).toBe(0);
      expect(transitionLeadStatus).not.toHaveBeenCalled();
    });

    it('counts failed when transitionLeadStatus throws after UPDATE succeeds (retry safety)', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findReplyForLead).mockResolvedValueOnce(REPLY_RESULT);
      vi.mocked(transitionLeadStatus).mockRejectedValueOnce(
        new Error('RPC error: invalid transition'),
      );

      const summary = await runReplyDetection();

      // UPDATE was called (replied_at is set; next poll can retry the RPC)
      const { from } = vi.mocked(getSupabaseClient).mock.results[0]!.value as {
        from: ReturnType<typeof vi.fn>;
      };
      expect(from.mock.results[0]!.value.update).toHaveBeenCalled();
      expect(summary.failed).toBe(1);
      expect(summary.replied).toBe(0);
    });
  });

  // ─── Notification callback error handling ─────────────────────────────────

  describe('notification callback error handling', () => {
    it('does not fail the lead when onReplyDetected throws', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findReplyForLead).mockResolvedValueOnce(REPLY_RESULT);
      vi.mocked(transitionLeadStatus).mockResolvedValueOnce({} as never);

      const onReplyDetected = vi.fn().mockRejectedValueOnce(new Error('Telegram 500'));

      const summary = await runReplyDetection(onReplyDetected);

      expect(summary.replied).toBe(1);
      expect(summary.failed).toBe(0);
    });

    it('logs notify error when onReplyDetected throws', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findReplyForLead).mockResolvedValueOnce(REPLY_RESULT);
      vi.mocked(transitionLeadStatus).mockResolvedValueOnce({} as never);

      const onReplyDetected = vi.fn().mockRejectedValueOnce(new Error('Telegram 500'));

      await runReplyDetection(onReplyDetected);

      const notifyErrorCall = vi.mocked(logJob).mock.calls.find(
        (c) => c[1] === 'error' && (c[2] as Record<string, unknown>).step === 'notify',
      );
      expect(notifyErrorCall).toBeDefined();
      expect(notifyErrorCall![2]).toMatchObject({ leadId: BASE_LEAD.id, step: 'notify' });
    });
  });

  // ─── Scan cap ────────────────────────────────────────────────────────────

  describe('scan cap', () => {
    it('sets capped=true when scanned count equals GMAIL_REPLY_POLL_MAX_LEADS', async () => {
      // Default max is 100; simulate exactly 100 leads returned
      const hundredLeads = Array.from({ length: 100 }, (_, i) => ({
        ...BASE_LEAD,
        id: `lead-${i}`,
      }));

      makeSupabaseMock(hundredLeads);
      vi.mocked(findReplyForLead).mockResolvedValue(null);

      const summary = await runReplyDetection();

      expect(summary.capped).toBe(true);
      expect(summary.scanned).toBe(100);
    });

    it('sets capped=false when fewer leads than the cap are returned', async () => {
      makeSupabaseMock([BASE_LEAD]);
      vi.mocked(findReplyForLead).mockResolvedValueOnce(null);

      const summary = await runReplyDetection();

      expect(summary.capped).toBe(false);
    });
  });

  // ─── Logging ─────────────────────────────────────────────────────────────

  describe('logging', () => {
    it('logs started then success on a clean run', async () => {
      makeSupabaseMock([]);

      await runReplyDetection();

      expect(logJob).toHaveBeenCalledWith('reply-detection', 'started', {});
      expect(logJob).toHaveBeenCalledWith(
        'reply-detection',
        'success',
        expect.objectContaining({ scanned: 0, replied: 0, pending: 0, failed: 0 }),
      );
    });

    it('logs error and rethrows when the Supabase lead fetch fails', async () => {
      makeSupabaseMockWithFetchError('connection timeout');

      await expect(runReplyDetection()).rejects.toThrow(
        'Failed to query reply-pending leads: connection timeout',
      );

      expect(logJob).toHaveBeenCalledWith(
        'reply-detection',
        'error',
        expect.objectContaining({ step: 'fetch_leads' }),
      );
    });
  });
});
