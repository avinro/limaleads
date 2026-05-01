import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('../db/client', () => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock('../integrations/gmailClient', () => ({
  createGmailDraft: vi.fn(),
}));

vi.mock('../integrations/telegramNotifier', () => ({
  sendTelegramAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/logger', () => ({
  logJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/leadStatus', () => ({
  transitionLeadStatus: vi.fn().mockResolvedValue({ id: 'event-id' }),
}));

import { getSupabaseClient } from '../db/client';
import { createGmailDraft } from '../integrations/gmailClient';
import { sendTelegramAlert } from '../integrations/telegramNotifier';
import { transitionLeadStatus } from '../lib/leadStatus';
import { logJob } from '../lib/logger';
import { runFollowUpScheduler } from './followUpScheduler';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// contacted_at 5 days ago: always past the 4-day threshold
const OLD_DATE = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
// contacted_at 1 day ago: does NOT pass the 4-day threshold
const RECENT_DATE = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

interface TemplateFixture {
  id: string;
  follow_up_body: string | null;
  follow_up_days: number;
}

interface LeadFixture {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  title: string | null;
  linkedin_url: string | null;
  status: string;
  follow_up_count: number;
  contacted_at: string | null;
  last_follow_up_at: string | null;
  gmail_thread_id: string;
  draft_subject: string | null;
  draft_body: string;
  templates: TemplateFixture | null;
}

const BASE_TEMPLATE: TemplateFixture = {
  id: 'template-uuid',
  follow_up_body: 'Hi {{name}}, just following up for {{company}}.',
  follow_up_days: 4,
};

const BASE_LEAD: LeadFixture = {
  id: 'lead-uuid-1',
  email: 'lead@acme.com',
  name: 'Sofia',
  company: 'Acme GmbH',
  title: 'Head of Marketing',
  linkedin_url: 'https://linkedin.com/in/sofia',
  status: 'contacted',
  follow_up_count: 0,
  contacted_at: OLD_DATE,
  last_follow_up_at: null,
  gmail_thread_id: 'thread-abc',
  draft_subject: 'Hello from Atelierra',
  draft_body: 'Original email body.',
  templates: BASE_TEMPLATE,
};

const DRAFT_RESULT = {
  draftId: 'draft-fu-1',
  messageId: 'msg-fu-1',
  threadId: 'thread-abc',
};

// ---------------------------------------------------------------------------
// Supabase mock helpers
// ---------------------------------------------------------------------------

/**
 * Builds a fluent Supabase mock for the scheduler's query chain:
 *   from('leads').select().in().not().not().not().order().limit() -> data
 *   from('leads').update({...}).eq('id', ...) -> { error: null }
 *
 * The same `from` mock object is reused for all calls because it carries
 * both `select` and `update`.
 */
function makeSupabaseMock(
  leads: LeadFixture[],
  updateError: { message: string } | null = null,
): void {
  // Build a single chain object that all `.not()`, `.in()`, `.order()` calls
  // can pass through. `limit` is the terminal call that resolves.
  const chain: Record<string, unknown> = {};
  chain.limit = vi.fn().mockResolvedValue({ data: leads, error: null });
  chain.order = vi.fn().mockReturnValue(chain);
  chain.not = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);

  // Update chain
  const eqUpdate = vi.fn().mockResolvedValue({ error: updateError });
  const update = vi.fn().mockReturnValue({ eq: eqUpdate });

  vi.mocked(getSupabaseClient).mockReturnValue({
    from: vi.fn().mockReturnValue({ ...chain, update }),
  } as never);
}

function makeSupabaseFetchError(errorMsg: string): void {
  const chain: Record<string, unknown> = {};
  chain.limit = vi.fn().mockResolvedValue({ data: null, error: { message: errorMsg } });
  chain.order = vi.fn().mockReturnValue(chain);
  chain.not = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);

  vi.mocked(getSupabaseClient).mockReturnValue({
    from: vi.fn().mockReturnValue({ ...chain }),
  } as never);
}

type FromResult = { update?: ReturnType<typeof vi.fn> };
type MockResultShape = { value: unknown };
function findUpdateCall(fromMock: ReturnType<typeof vi.fn>): Record<string, unknown> | undefined {
  const results = fromMock.mock.results as MockResultShape[];
  for (const r of results) {
    const v = r.value as FromResult;
    if (v?.update && typeof v.update.mock?.calls[0]?.[0] === 'object') {
      return v.update.mock.calls[0][0] as Record<string, unknown>;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runFollowUpScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendTelegramAlert).mockResolvedValue(undefined);
    vi.mocked(transitionLeadStatus).mockResolvedValue({ id: 'event-id' } as never);
    vi.mocked(createGmailDraft).mockResolvedValue(DRAFT_RESULT);
    delete process.env.MAX_FOLLOW_UPS;
    delete process.env.FOLLOW_UP_MAX_LEADS;
  });

  // ─── Happy path: contacted ────────────────────────────────────────────────

  describe('contacted lead past threshold', () => {
    it('creates draft, persists snapshot, transitions to follow_up_scheduled; counter unchanged', async () => {
      makeSupabaseMock([BASE_LEAD]);

      const summary = await runFollowUpScheduler();

      expect(summary).toEqual({
        scanned: 1,
        drafted: 1,
        exhausted: 0,
        skipped: 0,
        failed: 0,
      });

      expect(createGmailDraft).toHaveBeenCalledWith({
        to: BASE_LEAD.email,
        subject: `Re: ${BASE_LEAD.draft_subject}`,
        body: 'Hi Sofia, just following up for Acme GmbH.',
        threadId: BASE_LEAD.gmail_thread_id,
      });

      // Snapshot persisted via update
      const fromResult = vi.mocked(getSupabaseClient).mock.results[0]?.value as {
        from: ReturnType<typeof vi.fn>;
      };
      const updatePayload = findUpdateCall(fromResult.from);
      expect(updatePayload?.gmail_draft_id).toBe(DRAFT_RESULT.draftId);
      expect(updatePayload?.draft_subject).toBe(`Re: ${BASE_LEAD.draft_subject}`);

      // Status transition to follow_up_scheduled (not follow_up_sent)
      expect(transitionLeadStatus).toHaveBeenCalledWith(
        BASE_LEAD.id,
        'follow_up_scheduled',
        'system',
      );
      // follow_up_count must NOT be incremented here (only after sent detection)
      expect(transitionLeadStatus).not.toHaveBeenCalledWith(
        BASE_LEAD.id,
        'follow_up_sent',
        'system',
      );
    });

    it('uses placeholder substitution for follow_up_body', async () => {
      const lead = {
        ...BASE_LEAD,
        templates: {
          ...BASE_TEMPLATE,
          follow_up_body: 'Hey {{name}} from {{company}}!',
        },
      };
      makeSupabaseMock([lead]);

      await runFollowUpScheduler();

      expect(createGmailDraft).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Hey Sofia from Acme GmbH!' }),
      );
    });

    it('sends Re: prefix for subject', async () => {
      makeSupabaseMock([BASE_LEAD]);

      await runFollowUpScheduler();

      expect(createGmailDraft).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Re: Hello from Atelierra' }),
      );
    });

    it('passes threadId to createGmailDraft', async () => {
      makeSupabaseMock([BASE_LEAD]);

      await runFollowUpScheduler();

      expect(createGmailDraft).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: 'thread-abc' }),
      );
    });
  });

  // ─── Happy path: follow_up_sent with room for more ────────────────────────

  describe('follow_up_sent lead with count=1 (max=2)', () => {
    it('creates second follow-up draft and transitions to follow_up_scheduled; count unchanged', async () => {
      const lead = {
        ...BASE_LEAD,
        status: 'follow_up_sent',
        follow_up_count: 1,
        last_follow_up_at: OLD_DATE,
        contacted_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      };
      makeSupabaseMock([lead]);

      const summary = await runFollowUpScheduler();

      expect(summary.drafted).toBe(1);
      expect(summary.exhausted).toBe(0);
      expect(createGmailDraft).toHaveBeenCalledTimes(1);
      expect(transitionLeadStatus).toHaveBeenCalledWith(lead.id, 'follow_up_scheduled', 'system');
    });
  });

  // ─── Exhaustion ───────────────────────────────────────────────────────────

  describe('exhaustion', () => {
    it('transitions follow_up_sent lead to exhausted when count >= MAX_FOLLOW_UPS', async () => {
      const lead = {
        ...BASE_LEAD,
        status: 'follow_up_sent',
        follow_up_count: 2, // equals MAX_FOLLOW_UPS default (2)
        last_follow_up_at: OLD_DATE,
      };
      makeSupabaseMock([lead]);

      const summary = await runFollowUpScheduler();

      expect(summary.exhausted).toBe(1);
      expect(summary.drafted).toBe(0);
      expect(createGmailDraft).not.toHaveBeenCalled();
      expect(transitionLeadStatus).toHaveBeenCalledWith(lead.id, 'exhausted', 'system');
    });

    it('skips and logs contacted lead with count >= MAX_FOLLOW_UPS (invalid data — contacted -> exhausted not valid)', async () => {
      const lead = {
        ...BASE_LEAD,
        status: 'contacted',
        follow_up_count: 2,
      };
      makeSupabaseMock([lead]);

      const summary = await runFollowUpScheduler();

      expect(summary.skipped).toBe(1);
      expect(summary.drafted).toBe(0);
      expect(createGmailDraft).not.toHaveBeenCalled();
      expect(transitionLeadStatus).not.toHaveBeenCalled();
      expect(logJob).toHaveBeenCalledWith(
        'follow-up-scheduler',
        'error',
        expect.objectContaining({ step: 'skipped_invalid_exhaustion_state' }),
      );
    });

    it('respects MAX_FOLLOW_UPS env var', async () => {
      process.env.MAX_FOLLOW_UPS = '3';
      const lead = {
        ...BASE_LEAD,
        status: 'follow_up_sent',
        follow_up_count: 2, // 2 < 3 — should still create draft
        last_follow_up_at: OLD_DATE,
      };
      makeSupabaseMock([lead]);

      const summary = await runFollowUpScheduler();

      expect(summary.drafted).toBe(1);
      expect(summary.exhausted).toBe(0);
    });
  });

  // ─── Threshold filtering ─────────────────────────────────────────────────

  describe('threshold filtering', () => {
    it('does not create draft for lead under the threshold (handled by JS filter)', async () => {
      // The scheduler filters by threshold in TypeScript after the DB query.
      // Simulate a lead returned by DB but not old enough.
      const lead = {
        ...BASE_LEAD,
        contacted_at: RECENT_DATE, // only 1 day ago, threshold is 4 days
        last_follow_up_at: null,
      };
      makeSupabaseMock([lead]);

      const summary = await runFollowUpScheduler();

      // The lead was returned by the DB mock but filtered out in TypeScript
      expect(summary.drafted).toBe(0);
      expect(summary.scanned).toBe(0); // scanned reflects post-filter count
      expect(createGmailDraft).not.toHaveBeenCalled();
    });
  });

  // ─── Empty pool ───────────────────────────────────────────────────────────

  describe('empty pool', () => {
    it('returns all-zero summary and does not call Gmail or transition', async () => {
      makeSupabaseMock([]);

      const summary = await runFollowUpScheduler();

      expect(summary).toEqual({ scanned: 0, drafted: 0, exhausted: 0, skipped: 0, failed: 0 });
      expect(createGmailDraft).not.toHaveBeenCalled();
      expect(transitionLeadStatus).not.toHaveBeenCalled();
    });
  });

  // ─── Missing data exclusions ──────────────────────────────────────────────

  describe('leads excluded due to missing data', () => {
    it('excludes lead with no template (null templates)', async () => {
      const lead = { ...BASE_LEAD, templates: null };
      makeSupabaseMock([lead as typeof BASE_LEAD]);

      const summary = await runFollowUpScheduler();

      expect(summary.scanned).toBe(0);
      expect(createGmailDraft).not.toHaveBeenCalled();
    });

    it('excludes lead whose template has null follow_up_body', async () => {
      const lead = {
        ...BASE_LEAD,
        templates: { ...BASE_TEMPLATE, follow_up_body: null },
      };
      makeSupabaseMock([lead as typeof BASE_LEAD]);

      const summary = await runFollowUpScheduler();

      expect(summary.scanned).toBe(0);
      expect(createGmailDraft).not.toHaveBeenCalled();
    });

    it('excludes lead with null contacted_at (no reference timestamp)', async () => {
      const lead = { ...BASE_LEAD, contacted_at: null, last_follow_up_at: null };
      makeSupabaseMock([lead]);

      const summary = await runFollowUpScheduler();

      expect(summary.scanned).toBe(0);
      expect(createGmailDraft).not.toHaveBeenCalled();
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  describe('createGmailDraft fails', () => {
    it('logs error, sends Telegram alert, lead stays in original status, summary.failed++ and continues', async () => {
      const lead2 = { ...BASE_LEAD, id: 'lead-uuid-2', email: 'other@acme.com' };
      makeSupabaseMock([BASE_LEAD, lead2]);

      vi.mocked(createGmailDraft)
        .mockRejectedValueOnce(new Error('Gmail 403'))
        .mockResolvedValueOnce(DRAFT_RESULT);

      const summary = await runFollowUpScheduler();

      expect(summary.failed).toBe(1);
      expect(summary.drafted).toBe(1);
      expect(sendTelegramAlert).toHaveBeenCalledWith(expect.stringContaining('create_gmail_draft'));
      // lead 1 must NOT have been transitioned (it stays in 'contacted')
      expect(transitionLeadStatus).toHaveBeenCalledTimes(1);
      expect(transitionLeadStatus).toHaveBeenCalledWith(lead2.id, 'follow_up_scheduled', 'system');
    });
  });

  describe('persist/transition fails after draft creation', () => {
    it('logs error, sends Telegram alert, summary.failed++, loop continues', async () => {
      makeSupabaseMock([BASE_LEAD], { message: 'DB write failed' });

      const summary = await runFollowUpScheduler();

      // Draft was created but persistence failed
      expect(createGmailDraft).toHaveBeenCalledTimes(1);
      expect(summary.failed).toBe(1);
      expect(summary.drafted).toBe(0);
      expect(sendTelegramAlert).toHaveBeenCalledWith(
        expect.stringContaining('persist_or_transition'),
      );
    });
  });

  describe('exhaustion transition fails', () => {
    it('counts failed and continues when the exhausted transition throws', async () => {
      const lead = {
        ...BASE_LEAD,
        status: 'follow_up_sent',
        follow_up_count: 2,
        last_follow_up_at: OLD_DATE,
      };
      makeSupabaseMock([lead]);
      vi.mocked(transitionLeadStatus).mockRejectedValueOnce(new Error('RPC error'));

      const summary = await runFollowUpScheduler();

      expect(summary.failed).toBe(1);
      expect(summary.exhausted).toBe(0);
    });
  });

  // ─── Infrastructure error ─────────────────────────────────────────────────

  describe('Supabase fetch error', () => {
    it('logs and rethrows on initial DB query failure', async () => {
      makeSupabaseFetchError('connection timeout');

      await expect(runFollowUpScheduler()).rejects.toThrow(
        'Failed to query eligible follow-up leads: connection timeout',
      );

      expect(logJob).toHaveBeenCalledWith(
        'follow-up-scheduler',
        'error',
        expect.objectContaining({ step: 'fetch_leads' }),
      );
    });
  });

  // ─── Logging ─────────────────────────────────────────────────────────────

  describe('logging', () => {
    it('logs started and final success summary', async () => {
      makeSupabaseMock([]);

      await runFollowUpScheduler();

      expect(logJob).toHaveBeenCalledWith('follow-up-scheduler', 'started', {});
      expect(logJob).toHaveBeenCalledWith(
        'follow-up-scheduler',
        'success',
        expect.objectContaining({ scanned: 0, drafted: 0 }),
      );
    });

    it('logs per-lead success with draftId and threadId', async () => {
      makeSupabaseMock([BASE_LEAD]);

      await runFollowUpScheduler();

      expect(logJob).toHaveBeenCalledWith(
        'follow-up-scheduler',
        'success',
        expect.objectContaining({ leadId: BASE_LEAD.id, draftId: DRAFT_RESULT.draftId }),
      );
    });
  });

  // ─── null draft_subject fallback ─────────────────────────────────────────

  describe('null draft_subject fallback', () => {
    it('uses (no subject) when draft_subject is null', async () => {
      const lead = { ...BASE_LEAD, draft_subject: null };
      makeSupabaseMock([lead]);

      await runFollowUpScheduler();

      expect(createGmailDraft).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Re: (no subject)' }),
      );
    });
  });
});
