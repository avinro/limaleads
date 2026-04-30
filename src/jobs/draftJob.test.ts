import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../db/client', () => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock('./draftCreator', () => ({
  processLeadDraft: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  logJob: vi.fn().mockResolvedValue(undefined),
}));

import { getSupabaseClient } from '../db/client';
import { processLeadDraft } from './draftCreator';
import { logJob } from '../lib/logger';
import { runDraftJob } from './draftJob';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a Supabase mock whose from('leads').select().eq().order().limit()
 * chain resolves with a sequence of pages. Each call to limit() moves to the
 * next entry in `pages`; once exhausted, returns an empty array (queue drained).
 */
function makeSupabaseMock(pages: { id: string }[][]): void {
  let callCount = 0;

  const limit = vi.fn().mockImplementation(() => {
    const page = pages[callCount] ?? [];
    callCount += 1;
    return Promise.resolve({ data: page, error: null });
  });

  const order = vi.fn().mockReturnValue({ limit });
  const eq = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });

  vi.mocked(getSupabaseClient).mockReturnValue({ from } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDraftJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy path', () => {
    it('drains a single page and counts drafted correctly', async () => {
      makeSupabaseMock([[{ id: 'lead-1' }, { id: 'lead-2' }], []]);

      vi.mocked(processLeadDraft)
        .mockResolvedValueOnce({ leadId: 'lead-1', draftId: 'd1', messageId: 'm1', threadId: 't1' })
        .mockResolvedValueOnce({ leadId: 'lead-2', draftId: 'd2', messageId: 'm2', threadId: 't2' });

      const summary = await runDraftJob();

      expect(summary).toEqual({ scanned: 2, drafted: 2, failed: 0 });
      expect(processLeadDraft).toHaveBeenCalledTimes(2);
      expect(processLeadDraft).toHaveBeenCalledWith('lead-1');
      expect(processLeadDraft).toHaveBeenCalledWith('lead-2');
    });

    it('drains multiple pages until the queue is empty', async () => {
      makeSupabaseMock([[{ id: 'lead-1' }], [{ id: 'lead-2' }], []]);

      vi.mocked(processLeadDraft).mockResolvedValue({
        leadId: 'x',
        draftId: 'd',
        messageId: 'm',
        threadId: 't',
      });

      const summary = await runDraftJob();

      expect(summary.scanned).toBe(2);
      expect(summary.drafted).toBe(2);
    });

    it('returns zero counts when queue is already empty', async () => {
      makeSupabaseMock([[]]);

      const summary = await runDraftJob();

      expect(summary).toEqual({ scanned: 0, drafted: 0, failed: 0 });
      expect(processLeadDraft).not.toHaveBeenCalled();
    });
  });

  describe('failure handling', () => {
    it('counts null result from processLeadDraft as failed and continues', async () => {
      makeSupabaseMock([[{ id: 'lead-1' }, { id: 'lead-2' }], []]);

      vi.mocked(processLeadDraft)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ leadId: 'lead-2', draftId: 'd2', messageId: 'm2', threadId: 't2' });

      const summary = await runDraftJob();

      expect(summary).toEqual({ scanned: 2, drafted: 1, failed: 1 });
    });

    it('continues processing remaining leads even when one fails', async () => {
      makeSupabaseMock([[{ id: 'lead-1' }, { id: 'lead-2' }, { id: 'lead-3' }], []]);

      vi.mocked(processLeadDraft)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ leadId: 'lead-3', draftId: 'd3', messageId: 'm3', threadId: 't3' });

      const summary = await runDraftJob();

      expect(summary).toEqual({ scanned: 3, drafted: 1, failed: 2 });
      expect(processLeadDraft).toHaveBeenCalledTimes(3);
    });

    it('logs error and rethrows when Supabase query fails', async () => {
      const limit = vi.fn().mockResolvedValue({ data: null, error: { message: 'DB timeout' } });
      const order = vi.fn().mockReturnValue({ limit });
      const eq = vi.fn().mockReturnValue({ order });
      const select = vi.fn().mockReturnValue({ eq });
      const from = vi.fn().mockReturnValue({ select });
      vi.mocked(getSupabaseClient).mockReturnValue({ from } as never);

      await expect(runDraftJob()).rejects.toThrow('Failed to query new leads: DB timeout');

      expect(logJob).toHaveBeenCalledWith('draft-job', 'started', {});
      expect(logJob).toHaveBeenCalledWith(
        'draft-job',
        'error',
        expect.objectContaining({ error: expect.any(Object) }),
      );
    });
  });

  describe('job_log calls', () => {
    it('logs started then success on a successful run', async () => {
      makeSupabaseMock([[]]);

      await runDraftJob();

      expect(logJob).toHaveBeenCalledWith('draft-job', 'started', {});
      expect(logJob).toHaveBeenCalledWith(
        'draft-job',
        'success',
        expect.objectContaining({ scanned: 0, drafted: 0, failed: 0 }),
      );
    });

    it('includes partial summary in the error log when query throws mid-run', async () => {
      // First page succeeds, second throws.
      let callCount = 0;
      const limit = vi.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) return Promise.resolve({ data: [{ id: 'lead-1' }], error: null });
        return Promise.resolve({ data: null, error: { message: 'connection lost' } });
      });
      const order = vi.fn().mockReturnValue({ limit });
      const eq = vi.fn().mockReturnValue({ order });
      const select = vi.fn().mockReturnValue({ eq });
      const from = vi.fn().mockReturnValue({ select });
      vi.mocked(getSupabaseClient).mockReturnValue({ from } as never);

      vi.mocked(processLeadDraft).mockResolvedValue({
        leadId: 'lead-1',
        draftId: 'd1',
        messageId: 'm1',
        threadId: 't1',
      });

      await expect(runDraftJob()).rejects.toThrow();

      const errorCall = vi.mocked(logJob).mock.calls.find((c) => c[1] === 'error');
      expect(errorCall).toBeDefined();
      const details = errorCall![2] as { summary: { drafted: number } };
      expect(details.summary.drafted).toBe(1);
    });
  });
});
