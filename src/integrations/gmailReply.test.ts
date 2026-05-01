import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findReplyForLead, type LeadReplyInput } from './gmailReply';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockThreadsGet = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    gmail: vi.fn(() => ({
      users: {
        threads: { get: mockThreadsGet },
      },
    })),
  },
}));

vi.mock('./gmailAuth', () => ({
  getOAuth2Client: vi.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// contacted_at at 1_000_000 ms
const BASE_LEAD: LeadReplyInput = {
  id: 'lead-uuid-1',
  email: 'lead@acme.com',
  gmail_thread_id: 'thread-abc',
  contacted_at: new Date(1_000_000).toISOString(),
};

/**
 * Builds a minimal Gmail thread message fixture.
 * Defaults to a valid inbound reply from the lead.
 */
function makeMessage(overrides: {
  id?: string;
  labelIds?: string[];
  from?: string;
  internalDate?: number;
}): object {
  const {
    id = 'msg-reply-1',
    labelIds = ['INBOX', 'UNREAD'],
    from = 'lead@acme.com',
    internalDate = 2_000_000,
  } = overrides;

  return {
    id,
    threadId: 'thread-abc',
    labelIds,
    internalDate: String(internalDate),
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: 'Re: Hello from LimaLeads' },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findReplyForLead', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  // ─── Happy path ──────────────────────────────────────────────────────────

  it('returns reply result when lead sends a message after contacted_at', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [makeMessage({})] },
    });

    const result = await findReplyForLead(BASE_LEAD);

    expect(result).not.toBeNull();
    expect(result!.messageId).toBe('msg-reply-1');
    expect(result!.threadId).toBe('thread-abc');
    expect(result!.fromAddress).toBe('lead@acme.com');
    expect(result!.repliedAt).toEqual(new Date(2_000_000));
  });

  // ─── SENT / DRAFT exclusions ─────────────────────────────────────────────

  it('excludes messages with SENT label (rep outreach, not a reply)', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [makeMessage({ labelIds: ['SENT'], from: 'rep@example.com' })] },
    });

    const result = await findReplyForLead(BASE_LEAD);

    expect(result).toBeNull();
  });

  it('excludes messages with DRAFT label', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [makeMessage({ labelIds: ['DRAFT'] })] },
    });

    const result = await findReplyForLead(BASE_LEAD);

    expect(result).toBeNull();
  });

  // ─── Sender identity ─────────────────────────────────────────────────────

  it('excludes messages from non-lead senders', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [makeMessage({ from: 'someone-else@example.com' })] },
    });

    const result = await findReplyForLead(BASE_LEAD);

    expect(result).toBeNull();
  });

  it('accepts reply from lead email with display name formatting', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [makeMessage({ from: 'John Lead <lead@acme.com>' })] },
    });

    const result = await findReplyForLead(BASE_LEAD);

    expect(result).not.toBeNull();
    expect(result!.fromAddress).toBe('John Lead <lead@acme.com>');
  });

  // ─── Timestamp filter ────────────────────────────────────────────────────

  it('excludes messages more than 60s before contacted_at', async () => {
    // contacted_at = 1_000_000 ms; cutoff = 940_000 ms
    // 930_000 is 70s before contacted_at → excluded
    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [makeMessage({ internalDate: 930_000 })] },
    });

    const result = await findReplyForLead(BASE_LEAD);

    expect(result).toBeNull();
  });

  it('accepts messages within the 60s clock-skew tolerance window', async () => {
    // 970_000 is 30s before contacted_at → within the 60s tolerance window → accepted
    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [makeMessage({ internalDate: 970_000 })] },
    });

    const result = await findReplyForLead(BASE_LEAD);

    expect(result).not.toBeNull();
  });

  // ─── Earliest candidate ──────────────────────────────────────────────────

  it('returns the earliest valid reply when multiple exist in the thread', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [
          makeMessage({ id: 'msg-late', internalDate: 3_000_000 }),
          makeMessage({ id: 'msg-early', internalDate: 2_000_000 }),
        ],
      },
    });

    const result = await findReplyForLead(BASE_LEAD);

    expect(result!.messageId).toBe('msg-early');
  });

  // ─── Empty / no candidates ───────────────────────────────────────────────

  it('returns null when thread has no messages', async () => {
    mockThreadsGet.mockResolvedValueOnce({ data: { messages: [] } });

    const result = await findReplyForLead(BASE_LEAD);

    expect(result).toBeNull();
  });

  it('returns null when all messages are from the rep (SENT label)', async () => {
    const repMessage = makeMessage({ labelIds: ['SENT'], from: 'rep@example.com' });
    mockThreadsGet.mockResolvedValueOnce({ data: { messages: [repMessage] } });

    const result = await findReplyForLead(BASE_LEAD);

    expect(result).toBeNull();
  });

  // ─── 404 handling ────────────────────────────────────────────────────────

  it('returns null when Gmail returns 404 (thread deleted or access revoked)', async () => {
    mockThreadsGet.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));

    const result = await findReplyForLead(BASE_LEAD);

    expect(result).toBeNull();
  });

  it('rethrows non-404 Gmail API errors', async () => {
    mockThreadsGet.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));

    await expect(findReplyForLead(BASE_LEAD)).rejects.toThrow('Forbidden');
  });

  it('rethrows network errors without a status code', async () => {
    mockThreadsGet.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(findReplyForLead(BASE_LEAD)).rejects.toThrow('fetch failed');
  });
});
