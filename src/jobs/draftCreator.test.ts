import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../db/client', () => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock('../integrations/gmailClient', () => ({
  createGmailDraft: vi.fn(),
}));

vi.mock('../lib/logger', () => ({
  logJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/leadStatus', () => ({
  transitionLeadStatus: vi.fn().mockResolvedValue({ id: 'event-id' }),
}));

import { createGmailDraft } from '../integrations/gmailClient';
import { transitionLeadStatus } from '../lib/leadStatus';
import { logJob } from '../lib/logger';
import { getSupabaseClient } from '../db/client';
import { processLeadDraft } from './draftCreator';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LEAD = {
  id: 'lead-uuid',
  email: 'jane@acme.com',
  name: 'Jane Doe',
  company: 'Acme Corp',
  title: 'CEO',
  linkedin_url: 'https://linkedin.com/in/janedoe',
};

const TEMPLATE = {
  id: 'template-uuid',
  subject: 'Custom merch for {{company}}',
  body: 'Hi {{name}}, I wanted to reach out to {{company}}.',
};

const DRAFT_RESULT = {
  draftId: 'draft-abc',
  messageId: 'msg-abc',
  threadId: 'thread-abc',
};

// ---------------------------------------------------------------------------
// Supabase mock helpers
// ---------------------------------------------------------------------------

type SelectChain = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function makeSelectChain(returnValue: {
  data: unknown;
  error: null | { message: string };
}): SelectChain {
  const maybeSingle = vi.fn().mockResolvedValue(returnValue);
  const limit = vi.fn().mockReturnValue({ maybeSingle });
  const eq = vi
    .fn()
    .mockReturnValue({ maybeSingle, limit, eq: vi.fn().mockReturnValue({ maybeSingle }) });
  const select = vi.fn().mockReturnValue({ eq });
  return { select, eq, maybeSingle, limit, update: vi.fn() };
}

function makeUpdateChain(returnValue: { error: null | { message: string } }) {
  const eq = vi.fn().mockResolvedValue(returnValue);
  return { update: vi.fn().mockReturnValue({ eq }) };
}

// Builds a minimal Supabase client mock that sequences:
//   from('leads').select(...)  -> leadReturn
//   from('templates').select(...)  -> templateReturn
//   from('leads').update(...)  -> updateReturn
function mockSupabase(
  leadReturn: { data: unknown; error: null | { message: string } },
  templateReturn: { data: unknown; error: null | { message: string } },
  updateReturn: { error: null | { message: string } } = { error: null },
) {
  const leadSelectChain = makeSelectChain(leadReturn);
  const templateSelectChain = makeSelectChain(templateReturn);
  const leadUpdateChain = makeUpdateChain(updateReturn);

  let leadSelectCalled = false;

  vi.mocked(getSupabaseClient).mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === 'templates') {
        return templateSelectChain;
      }
      // leads: first call is select, second is update
      if (!leadSelectCalled) {
        leadSelectCalled = true;
        return leadSelectChain;
      }
      return leadUpdateChain;
    }),
  } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processLeadDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('happy path', () => {
    it('creates a draft, persists IDs, transitions to draft_created, and returns result', async () => {
      mockSupabase({ data: LEAD, error: null }, { data: TEMPLATE, error: null });
      vi.mocked(createGmailDraft).mockResolvedValue(DRAFT_RESULT);

      const result = await processLeadDraft('lead-uuid');

      expect(result).toEqual({
        leadId: 'lead-uuid',
        draftId: 'draft-abc',
        messageId: 'msg-abc',
        threadId: 'thread-abc',
      });

      expect(createGmailDraft).toHaveBeenCalledWith({
        to: LEAD.email,
        subject: 'Custom merch for Acme Corp',
        body: 'Hi Jane Doe, I wanted to reach out to Acme Corp.',
      });

      expect(transitionLeadStatus).toHaveBeenCalledWith('lead-uuid', 'draft_created', 'system');
      expect(logJob).toHaveBeenCalledWith(
        'draft-creator',
        'success',
        expect.objectContaining({ leadId: 'lead-uuid' }),
      );
    });

    it('applies all placeholder types correctly', async () => {
      const richTemplate = {
        id: 'template-uuid',
        subject: '{{name}} at {{company}}',
        body: '{{title}} | {{linkedin_url}}',
      };
      mockSupabase({ data: LEAD, error: null }, { data: richTemplate, error: null });
      vi.mocked(createGmailDraft).mockResolvedValue(DRAFT_RESULT);

      await processLeadDraft('lead-uuid');

      expect(createGmailDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Jane Doe at Acme Corp',
          body: 'CEO | https://linkedin.com/in/janedoe',
        }),
      );
    });

    it('replaces missing lead fields with empty string', async () => {
      const spareLead = { ...LEAD, name: null, company: null };
      mockSupabase({ data: spareLead, error: null }, { data: TEMPLATE, error: null });
      vi.mocked(createGmailDraft).mockResolvedValue(DRAFT_RESULT);

      await processLeadDraft('lead-uuid');

      expect(createGmailDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Custom merch for ',
          body: 'Hi , I wanted to reach out to .',
        }),
      );
    });
  });

  describe('lead not found', () => {
    it('logs error and returns null without transitioning status', async () => {
      mockSupabase({ data: null, error: null }, { data: TEMPLATE, error: null });

      const result = await processLeadDraft('lead-uuid');

      expect(result).toBeNull();
      expect(createGmailDraft).not.toHaveBeenCalled();
      expect(transitionLeadStatus).not.toHaveBeenCalled();
      expect(logJob).toHaveBeenCalledWith(
        'draft-creator',
        'error',
        expect.objectContaining({ leadId: 'lead-uuid' }),
      );
    });
  });

  describe('no active template', () => {
    it('logs error, transitions to generation_failed, and returns null', async () => {
      mockSupabase({ data: LEAD, error: null }, { data: null, error: null });

      const result = await processLeadDraft('lead-uuid');

      expect(result).toBeNull();
      expect(createGmailDraft).not.toHaveBeenCalled();
      expect(transitionLeadStatus).toHaveBeenCalledWith('lead-uuid', 'generation_failed', 'system');
      expect(logJob).toHaveBeenCalledWith(
        'draft-creator',
        'error',
        expect.objectContaining({ step: 'fetch_template' }),
      );
    });
  });

  describe('Gmail API failure', () => {
    it('logs error, transitions to generation_failed, and returns null without throwing', async () => {
      mockSupabase({ data: LEAD, error: null }, { data: TEMPLATE, error: null });
      vi.mocked(createGmailDraft).mockRejectedValue(new Error('Gmail 403 Forbidden'));

      const result = await processLeadDraft('lead-uuid');

      expect(result).toBeNull();
      expect(transitionLeadStatus).toHaveBeenCalledWith('lead-uuid', 'generation_failed', 'system');
      expect(logJob).toHaveBeenCalledWith(
        'draft-creator',
        'error',
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Gmail 403 Forbidden' }),
        }),
      );
    });
  });

  describe('generation_failed transition also fails', () => {
    it('logs both errors and still returns null without throwing', async () => {
      mockSupabase({ data: LEAD, error: null }, { data: TEMPLATE, error: null });
      vi.mocked(createGmailDraft).mockRejectedValue(new Error('Gmail timeout'));
      vi.mocked(transitionLeadStatus).mockRejectedValue(new Error('RPC down'));

      const result = await processLeadDraft('lead-uuid');

      expect(result).toBeNull();
      expect(logJob).toHaveBeenCalledTimes(2);
    });
  });
});
