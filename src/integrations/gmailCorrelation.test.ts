import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectEdit, findSentMessageForLead, type LeadCorrelationInput } from './gmailCorrelation';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockThreadsGet = vi.fn();
const mockMessagesList = vi.fn();
const mockMessagesGet = vi.fn();
const mockGetProfile = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    gmail: vi.fn(() => ({
      users: {
        threads: { get: mockThreadsGet },
        messages: { list: mockMessagesList, get: mockMessagesGet },
        getProfile: mockGetProfile,
      },
    })),
  },
}));

vi.mock('./gmailAuth', () => ({
  getOAuth2Client: vi.fn(() => ({})),
  getRepSenderEmail: vi.fn(async () => 'rep@example.com'),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_LEAD: LeadCorrelationInput = {
  id: 'lead-uuid-1',
  email: 'lead@acme.com',
  gmail_thread_id: 'thread-abc',
  draft_subject: 'Hello from LimaLeads',
  draft_body: 'Hi John, reaching out about Acme.',
  created_at: new Date(1_000_000).toISOString(), // 1970-01-01T00:16:40.000Z
};

/** Builds a raw base64url-encoded string from a plain string. */
function b64url(text: string): string {
  return Buffer.from(text)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Returns a minimal Gmail thread message fixture for threads.get responses. */
function makeThreadMessage(overrides: {
  id?: string;
  labelIds?: string[];
  from?: string;
  to?: string;
  internalDate?: number;
}): object {
  const {
    id = 'msg-1',
    labelIds = ['SENT'],
    from = 'rep@example.com',
    to = 'lead@acme.com',
    internalDate = 2_000_000, // after BASE_LEAD.created_at
  } = overrides;

  return {
    id,
    threadId: 'thread-abc',
    labelIds,
    internalDate: String(internalDate),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: 'Hello from LimaLeads' },
      ],
      body: { data: b64url('Hi John, reaching out about Acme.') },
    },
  };
}

/** Returns a minimal full-message fixture for messages.get responses. */
function makeFullMessage(body: string, overrides: { id?: string; threadId?: string; internalDate?: number } = {}): object {
  return {
    id: overrides.id ?? 'msg-1',
    threadId: overrides.threadId ?? 'thread-abc',
    internalDate: String(overrides.internalDate ?? 2_000_000),
    payload: {
      mimeType: 'text/plain',
      body: { data: b64url(body) },
    },
  };
}

// ---------------------------------------------------------------------------
// detectEdit (pure unit tests — no mocks needed)
// ---------------------------------------------------------------------------

describe('detectEdit', () => {
  it('returns false when bodies are identical', () => {
    expect(detectEdit('Hello world', 'Hello world')).toBe(false);
  });

  it('returns false when bodies differ only in whitespace normalization', () => {
    expect(detectEdit('Hello  world\r\n', 'Hello world\n')).toBe(false);
  });

  it('returns true when bodies differ in content', () => {
    expect(detectEdit('Original body', 'Edited body')).toBe(true);
  });

  it('returns false when draft_body is null', () => {
    expect(detectEdit(null, 'Any sent body')).toBe(false);
  });

  it('returns false when draft_body is blank', () => {
    expect(detectEdit('   ', 'Any sent body')).toBe(false);
  });

  it('returns false when draft_body is empty string', () => {
    expect(detectEdit('', 'Any sent body')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findSentMessageForLead — thread-first strategy
// ---------------------------------------------------------------------------

describe('findSentMessageForLead — thread strategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: returns result with editedBeforeSend = false when body matches draft', async () => {
    const sentBody = 'Hi John, reaching out about Acme.';

    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [makeThreadMessage({})] },
    });
    mockMessagesGet.mockResolvedValueOnce({ data: makeFullMessage(sentBody) });

    const result = await findSentMessageForLead(BASE_LEAD);

    expect(result).not.toBeNull();
    expect(result!.messageId).toBe('msg-1');
    expect(result!.threadId).toBe('thread-abc');
    expect(result!.editedBeforeSend).toBe(false);
    expect(result!.body).toBe(sentBody);
  });

  it('returns editedBeforeSend = true when sent body differs from draft_body', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [makeThreadMessage({})] },
    });
    mockMessagesGet.mockResolvedValueOnce({
      data: makeFullMessage('Hi John, I edited this before sending.'),
    });

    const result = await findSentMessageForLead(BASE_LEAD);

    expect(result).not.toBeNull();
    expect(result!.editedBeforeSend).toBe(true);
  });

  it('returns editedBeforeSend = false when draft_body is null', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [makeThreadMessage({})] },
    });
    mockMessagesGet.mockResolvedValueOnce({
      data: makeFullMessage('Any sent content'),
    });

    const lead = { ...BASE_LEAD, draft_body: null };
    const result = await findSentMessageForLead(lead);

    expect(result).not.toBeNull();
    expect(result!.editedBeforeSend).toBe(false);
  });

  it('returns null when thread has no messages with SENT label', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [
          makeThreadMessage({ labelIds: ['INBOX'], from: 'lead@acme.com', to: 'rep@example.com' }),
        ],
      },
    });

    const result = await findSentMessageForLead({ ...BASE_LEAD, draft_subject: null });
    expect(result).toBeNull();
    expect(mockMessagesList).not.toHaveBeenCalled();
  });

  it('returns null when SENT message is from a different sender', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [
          makeThreadMessage({ from: 'other@example.com' }),
        ],
      },
    });

    const result = await findSentMessageForLead({ ...BASE_LEAD, draft_subject: null });
    expect(result).toBeNull();
  });

  it('returns null when SENT message does not include lead.email in To/Cc/Bcc', async () => {
    mockThreadsGet.mockResolvedValueOnce({
      data: {
        messages: [
          makeThreadMessage({ to: 'someone-else@example.com' }),
        ],
      },
    });

    const result = await findSentMessageForLead({ ...BASE_LEAD, draft_subject: null });
    expect(result).toBeNull();
  });

  it('chooses the earliest valid SENT message when multiple exist in the thread', async () => {
    const early = makeThreadMessage({ id: 'msg-early', internalDate: 2_000_000 });
    const late = makeThreadMessage({ id: 'msg-late', internalDate: 3_000_000 });

    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [late, early] }, // unordered on purpose
    });
    // Full body fetch called for the earliest message
    mockMessagesGet.mockResolvedValueOnce({ data: makeFullMessage('Body', { id: 'msg-early' }) });

    const result = await findSentMessageForLead(BASE_LEAD);

    expect(result).not.toBeNull();
    expect(result!.messageId).toBe('msg-early');
  });

  it('ignores SENT messages sent before lead.created_at', async () => {
    // internalDate is 500_000 ms, which is before BASE_LEAD.created_at (1_000_000 ms)
    const oldMessage = makeThreadMessage({ internalDate: 500_000 });

    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [oldMessage] },
    });

    const result = await findSentMessageForLead({ ...BASE_LEAD, draft_subject: null });
    expect(result).toBeNull();
  });

  it('matches lead.email that appears in Cc header', async () => {
    const msg = makeThreadMessage({ to: 'primary@example.com' });
    // Inject a Cc header
    const msgWithCc = JSON.parse(JSON.stringify(msg)) as { payload: { headers: Array<{ name: string; value: string }> } };
    msgWithCc.payload.headers.push({ name: 'Cc', value: 'lead@acme.com' });

    mockThreadsGet.mockResolvedValueOnce({ data: { messages: [msgWithCc] } });
    mockMessagesGet.mockResolvedValueOnce({ data: makeFullMessage('Body') });

    const result = await findSentMessageForLead(BASE_LEAD);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findSentMessageForLead — subject fallback strategy
// ---------------------------------------------------------------------------

describe('findSentMessageForLead — subject fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses subject search when gmail_thread_id is null and draft_subject is set', async () => {
    const lead = { ...BASE_LEAD, gmail_thread_id: null };

    mockMessagesList.mockResolvedValueOnce({
      data: { messages: [{ id: 'msg-found' }] },
    });
    mockMessagesGet
      // metadata fetch
      .mockResolvedValueOnce({
        data: {
          id: 'msg-found',
          threadId: 'thread-xyz',
          internalDate: String(2_000_000),
          payload: {
            headers: [
              { name: 'From', value: 'rep@example.com' },
              { name: 'To', value: 'lead@acme.com' },
            ],
          },
        },
      })
      // full body fetch
      .mockResolvedValueOnce({
        data: makeFullMessage('Hi John, reaching out about Acme.', {
          id: 'msg-found',
          threadId: 'thread-xyz',
        }),
      });

    const result = await findSentMessageForLead(lead);

    expect(mockThreadsGet).not.toHaveBeenCalled();
    expect(mockMessagesList).toHaveBeenCalledOnce();
    const [[callArgs]] = mockMessagesList.mock.calls as [[{ q: string }]];
    expect(callArgs.q).toContain('in:sent');
    expect(callArgs.q).toContain('Hello from LimaLeads');

    expect(result).not.toBeNull();
    expect(result!.messageId).toBe('msg-found');
    expect(result!.threadId).toBe('thread-xyz');
  });

  it('returns null when gmail_thread_id and draft_subject are both null', async () => {
    const lead = { ...BASE_LEAD, gmail_thread_id: null, draft_subject: null };

    const result = await findSentMessageForLead(lead);

    expect(mockThreadsGet).not.toHaveBeenCalled();
    expect(mockMessagesList).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('returns null when subject search returns no messages', async () => {
    const lead = { ...BASE_LEAD, gmail_thread_id: null };

    mockMessagesList.mockResolvedValueOnce({ data: { messages: [] } });

    const result = await findSentMessageForLead(lead);
    expect(result).toBeNull();
  });

  it('filters out subject-fallback candidates from wrong sender', async () => {
    const lead = { ...BASE_LEAD, gmail_thread_id: null };

    mockMessagesList.mockResolvedValueOnce({
      data: { messages: [{ id: 'msg-wrong' }] },
    });
    mockMessagesGet.mockResolvedValueOnce({
      data: {
        id: 'msg-wrong',
        threadId: 'thread-xyz',
        internalDate: String(2_000_000),
        payload: {
          headers: [
            { name: 'From', value: 'hacker@evil.com' },
            { name: 'To', value: 'lead@acme.com' },
          ],
        },
      },
    });

    const result = await findSentMessageForLead(lead);
    expect(result).toBeNull();
  });

  it('falls back to subject search when thread match fails', async () => {
    // Thread has no valid SENT message
    mockThreadsGet.mockResolvedValueOnce({
      data: { messages: [makeThreadMessage({ from: 'other@example.com' })] },
    });

    // Subject fallback succeeds
    mockMessagesList.mockResolvedValueOnce({
      data: { messages: [{ id: 'msg-fallback' }] },
    });
    mockMessagesGet
      .mockResolvedValueOnce({
        data: {
          id: 'msg-fallback',
          threadId: 'thread-fallback',
          internalDate: String(2_000_000),
          payload: {
            headers: [
              { name: 'From', value: 'rep@example.com' },
              { name: 'To', value: 'lead@acme.com' },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        data: makeFullMessage('Body', { id: 'msg-fallback', threadId: 'thread-fallback' }),
      });

    const result = await findSentMessageForLead(BASE_LEAD);

    expect(result).not.toBeNull();
    expect(result!.messageId).toBe('msg-fallback');
  });
});
