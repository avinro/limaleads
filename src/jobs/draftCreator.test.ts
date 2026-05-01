import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../db/client', () => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock('../integrations/geminiClient', () => ({
  generateEmail: vi.fn(),
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

import { generateEmail } from '../integrations/geminiClient';
import { createGmailDraft } from '../integrations/gmailClient';
import { sendTelegramAlert } from '../integrations/telegramNotifier';
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
  country: 'US',
  company_hook: 'Acme recently launched a new product line',
  source_criteria: '{"role":"CEO"}',
};

const TEMPLATE = {
  id: 'template-uuid',
  subject: 'Fashion merch for {{company}}',
  body: 'Hi {{name}}, we produce fashion-level merch.',
};

const GENERATED = {
  subject: 'AI-generated subject for Acme',
  body: 'Hello Jane, we are Atelierra and we produce fashion-level merch for Acme Corp.',
};

const DRAFT_RESULT = {
  draftId: 'draft-abc',
  messageId: 'msg-abc',
  threadId: 'thread-abc',
};

// ---------------------------------------------------------------------------
// Supabase mock helpers
//
// The new flow makes these calls against the leads table:
//   1. from('leads').select(...)          → fetch lead
//   2. from('templates').select(...)      → fetch active template
//   3. from('leads').update({template_id}) → persist template_id
//   4. from('leads').update({gmail_*,...}) → persist draft fields
//
// We track call counts to route them correctly.
// ---------------------------------------------------------------------------

type ChainWithMaybeSingle = {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
};

function makeSelectChain(returnValue: {
  data: unknown;
  error: null | { message: string };
}): ChainWithMaybeSingle {
  const maybeSingle = vi.fn().mockResolvedValue(returnValue);
  const limit = vi.fn().mockReturnValue({ maybeSingle });
  const innerEq = vi.fn().mockReturnValue({ maybeSingle });
  const eq = vi.fn().mockReturnValue({ maybeSingle, limit, eq: innerEq });
  const select = vi.fn().mockReturnValue({ eq });
  return { select, eq, maybeSingle, limit };
}

function makeUpdateChain(returnValue: { error: null | { message: string } }) {
  const eq = vi.fn().mockResolvedValue(returnValue);
  return { update: vi.fn().mockReturnValue({ eq }) };
}

/**
 * Configures a Supabase client mock that sequences the four table calls made
 * by processLeadDraft.
 *
 * leadsUpdate1 = leads.update({ template_id })  (step 3)
 * leadsUpdate2 = leads.update({ gmail_* })      (step 6)
 */
function mockSupabase(opts: {
  lead: { data: unknown; error: null | { message: string } };
  template: { data: unknown; error: null | { message: string } };
  leadsUpdate1?: { error: null | { message: string } };
  leadsUpdate2?: { error: null | { message: string } };
}): void {
  const { lead, template, leadsUpdate1 = { error: null }, leadsUpdate2 = { error: null } } = opts;

  const leadSelectChain = makeSelectChain(lead);
  const templateSelectChain = makeSelectChain(template);
  const update1Chain = makeUpdateChain(leadsUpdate1);
  const update2Chain = makeUpdateChain(leadsUpdate2);

  let leadsCallCount = 0;

  vi.mocked(getSupabaseClient).mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === 'templates') {
        return templateSelectChain;
      }
      // leads: first call = select, second call = update(template_id), third = update(draft fields)
      leadsCallCount += 1;
      if (leadsCallCount === 1) return leadSelectChain;
      if (leadsCallCount === 2) return update1Chain;
      return update2Chain;
    }),
  } as never);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processLeadDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendTelegramAlert).mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  describe('happy path', () => {
    it('generates email via Gemini, creates Gmail draft, persists template_id and draft fields, transitions to draft_created', async () => {
      mockSupabase({
        lead: { data: LEAD, error: null },
        template: { data: TEMPLATE, error: null },
      });
      vi.mocked(generateEmail).mockResolvedValue(GENERATED);
      vi.mocked(createGmailDraft).mockResolvedValue(DRAFT_RESULT);

      const result = await processLeadDraft('lead-uuid');

      expect(result).toEqual({
        leadId: 'lead-uuid',
        draftId: 'draft-abc',
        messageId: 'msg-abc',
        threadId: 'thread-abc',
      });

      // Gemini called with correct context
      expect(generateEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Jane Doe',
          company: 'Acme Corp',
          title: 'CEO',
          linkedinUrl: 'https://linkedin.com/in/janedoe',
          country: 'US',
          language: 'en',
          companyHook: 'Acme recently launched a new product line',
          sourceCriteria: '{"role":"CEO"}',
        }),
        { body: TEMPLATE.body },
      );

      // Gmail draft uses generated values, NOT raw template
      expect(createGmailDraft).toHaveBeenCalledWith({
        to: LEAD.email,
        subject: GENERATED.subject,
        body: GENERATED.body,
      });

      // Status transition
      expect(transitionLeadStatus).toHaveBeenCalledWith('lead-uuid', 'draft_created', 'system');

      // No Telegram alert on success
      expect(sendTelegramAlert).not.toHaveBeenCalled();

      // Success logged
      expect(logJob).toHaveBeenCalledWith(
        'draft-creator',
        'success',
        expect.objectContaining({ leadId: 'lead-uuid', draftId: 'draft-abc' }),
      );
    });

    it('passes language=de for DACH country', async () => {
      const germanLead = { ...LEAD, country: 'DE' };
      mockSupabase({
        lead: { data: germanLead, error: null },
        template: { data: TEMPLATE, error: null },
      });
      vi.mocked(generateEmail).mockResolvedValue(GENERATED);
      vi.mocked(createGmailDraft).mockResolvedValue(DRAFT_RESULT);

      await processLeadDraft('lead-uuid');

      expect(generateEmail).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'de' }),
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('lead not found', () => {
    it('logs error and returns null — no transition, no Telegram alert', async () => {
      mockSupabase({
        lead: { data: null, error: null },
        template: { data: TEMPLATE, error: null },
      });

      const result = await processLeadDraft('lead-uuid');

      expect(result).toBeNull();
      expect(generateEmail).not.toHaveBeenCalled();
      expect(createGmailDraft).not.toHaveBeenCalled();
      expect(transitionLeadStatus).not.toHaveBeenCalled();
      expect(sendTelegramAlert).not.toHaveBeenCalled();
      expect(logJob).toHaveBeenCalledWith(
        'draft-creator',
        'error',
        expect.objectContaining({ leadId: 'lead-uuid', error: 'Lead not found' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('no active template', () => {
    it('logs error, fires Telegram alert, transitions to generation_failed, returns null', async () => {
      mockSupabase({ lead: { data: LEAD, error: null }, template: { data: null, error: null } });

      const result = await processLeadDraft('lead-uuid');

      expect(result).toBeNull();
      expect(generateEmail).not.toHaveBeenCalled();
      expect(createGmailDraft).not.toHaveBeenCalled();
      expect(transitionLeadStatus).toHaveBeenCalledWith('lead-uuid', 'generation_failed', 'system');
      expect(sendTelegramAlert).toHaveBeenCalledWith(expect.stringContaining('generation_failed'));
      expect(sendTelegramAlert).toHaveBeenCalledWith(expect.stringContaining('lead-uuid'));
    });
  });

  // -------------------------------------------------------------------------
  describe('template_id update fails', () => {
    it('logs error, fires Telegram alert, transitions to generation_failed, does not call Gemini', async () => {
      mockSupabase({
        lead: { data: LEAD, error: null },
        template: { data: TEMPLATE, error: null },
        leadsUpdate1: { error: { message: 'DB constraint violation' } },
      });

      const result = await processLeadDraft('lead-uuid');

      expect(result).toBeNull();
      expect(generateEmail).not.toHaveBeenCalled();
      expect(createGmailDraft).not.toHaveBeenCalled();
      expect(transitionLeadStatus).toHaveBeenCalledWith('lead-uuid', 'generation_failed', 'system');
      expect(sendTelegramAlert).toHaveBeenCalledWith(
        expect.stringContaining('persist_template_id'),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('Gemini generation fails', () => {
    it('logs error, fires Telegram alert, transitions to generation_failed, no Gmail draft', async () => {
      mockSupabase({
        lead: { data: LEAD, error: null },
        template: { data: TEMPLATE, error: null },
      });
      vi.mocked(generateEmail).mockRejectedValue(new Error('Gemini 500 Internal Server Error'));

      const result = await processLeadDraft('lead-uuid');

      expect(result).toBeNull();
      expect(createGmailDraft).not.toHaveBeenCalled();
      expect(transitionLeadStatus).toHaveBeenCalledWith('lead-uuid', 'generation_failed', 'system');
      expect(sendTelegramAlert).toHaveBeenCalledWith(expect.stringContaining('generate_email'));
      expect(logJob).toHaveBeenCalledWith(
        'draft-creator',
        'error',
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Gemini 500 Internal Server Error' }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('Gmail API fails', () => {
    it('logs error, fires Telegram alert, transitions to generation_failed, returns null without throwing', async () => {
      mockSupabase({
        lead: { data: LEAD, error: null },
        template: { data: TEMPLATE, error: null },
      });
      vi.mocked(generateEmail).mockResolvedValue(GENERATED);
      vi.mocked(createGmailDraft).mockRejectedValue(new Error('Gmail 403 Forbidden'));

      const result = await processLeadDraft('lead-uuid');

      expect(result).toBeNull();
      expect(transitionLeadStatus).toHaveBeenCalledWith('lead-uuid', 'generation_failed', 'system');
      expect(sendTelegramAlert).toHaveBeenCalledWith(expect.stringContaining('create_gmail_draft'));
      expect(logJob).toHaveBeenCalledWith(
        'draft-creator',
        'error',
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Gmail 403 Forbidden' }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('generation_failed transition itself fails', () => {
    it('logs both the root error and the transition error, still returns null without throwing', async () => {
      mockSupabase({
        lead: { data: LEAD, error: null },
        template: { data: TEMPLATE, error: null },
      });
      vi.mocked(generateEmail).mockRejectedValue(new Error('Gemini timeout'));
      vi.mocked(transitionLeadStatus).mockRejectedValue(new Error('RPC down'));

      const result = await processLeadDraft('lead-uuid');

      expect(result).toBeNull();
      // At least two job_log error entries: the root error + the transition failure
      const errorCalls = vi.mocked(logJob).mock.calls.filter((c) => c[1] === 'error');
      expect(errorCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('Telegram alert fails', () => {
    it('processLeadDraft still returns null without rethrowing; Telegram failure is logged', async () => {
      mockSupabase({ lead: { data: LEAD, error: null }, template: { data: null, error: null } });
      vi.mocked(sendTelegramAlert).mockRejectedValue(new Error('Telegram network error'));

      const result = await processLeadDraft('lead-uuid');

      expect(result).toBeNull();
      expect(transitionLeadStatus).toHaveBeenCalledWith('lead-uuid', 'generation_failed', 'system');
      // The Telegram failure itself should be logged
      expect(logJob).toHaveBeenCalledWith(
        'draft-creator',
        'error',
        expect.objectContaining({ step: 'telegram_alert_failed' }),
      );
    });
  });
});
