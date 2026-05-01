import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyLeadReply, sendTelegramAlert } from './telegramNotifier';

// ---------------------------------------------------------------------------
// Mock global fetch and logger
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../lib/logger', () => ({
  logJob: vi.fn().mockResolvedValue(undefined),
}));

import { logJob } from '../lib/logger';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_INPUT = {
  lead: {
    id: 'lead-uuid-1',
    name: 'John Lead',
    company: 'Acme Corp',
    title: 'CEO',
  },
  reply: {
    threadId: 'thread-abc',
    snippet: 'Thanks for reaching out!',
    repliedAt: new Date('2026-05-01T17:00:00.000Z'),
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchOk(): void {
  mockFetch.mockResolvedValueOnce({ ok: true });
}

function mockFetchFail(status = 500, body = 'Internal Server Error'): void {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => body,
  });
}

// ---------------------------------------------------------------------------
// sendTelegramAlert tests
// ---------------------------------------------------------------------------

describe('sendTelegramAlert', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('logs a warning and resolves when TELEGRAM_BOT_TOKEN is missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_CHAT_ID = '12345';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sendTelegramAlert('test alert')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TELEGRAM_BOT_TOKEN'));
    expect(mockFetch).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('logs a warning and resolves when TELEGRAM_CHAT_ID is missing', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    delete process.env.TELEGRAM_CHAT_ID;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sendTelegramAlert('test alert')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TELEGRAM_CHAT_ID'));
    expect(mockFetch).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('calls the Telegram API and resolves on a 2xx response', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '12345';

    mockFetchOk();

    await expect(sendTelegramAlert('pipeline error')).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/bottest-token/sendMessage');
    expect(JSON.parse(options.body as string)).toMatchObject({
      chat_id: '12345',
      text: 'pipeline error',
    });
  });

  it('does NOT include parse_mode in body when no options passed', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '12345';

    mockFetchOk();

    await sendTelegramAlert('plain text');

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.parse_mode).toBeUndefined();
  });

  it('includes parse_mode: HTML in body when parseMode option is passed', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = '12345';

    mockFetchOk();

    await sendTelegramAlert('<b>bold</b>', { parseMode: 'HTML' });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toBe('<b>bold</b>');
  });

  it('throws a descriptive error on a non-2xx Telegram response', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bad-token';
    process.env.TELEGRAM_CHAT_ID = '12345';

    mockFetchFail(401, '{"description":"Unauthorized"}');

    await expect(sendTelegramAlert('test')).rejects.toThrow('Telegram API error 401');
  });
});

// ---------------------------------------------------------------------------
// notifyLeadReply tests
// ---------------------------------------------------------------------------

describe('notifyLeadReply', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_CHAT_ID: '12345',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ─── Happy path ──────────────────────────────────────────────────────────

  it('sends a single HTML message with escaped lead fields, snippet, link, and timestamp', async () => {
    mockFetchOk();

    await notifyLeadReply(BASE_INPUT);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/sendMessage');

    const body = JSON.parse(options.body as string) as Record<string, string>;
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('John Lead');
    expect(body.text).toContain('CEO');
    expect(body.text).toContain('Acme Corp');
    expect(body.text).toContain('Thanks for reaching out!');
    expect(body.text).toContain('2026-05-01T17:00:00.000Z');
    expect(body.text).toContain('mail.google.com/mail/u/0/#all/');
    expect(body.text).toContain(encodeURIComponent('thread-abc'));
  });

  it('HTML-escapes special characters in lead fields', async () => {
    mockFetchOk();

    await notifyLeadReply({
      ...BASE_INPUT,
      lead: { id: 'x', name: '<Evil>', company: 'A&B', title: '"Founder"' },
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, string>;
    expect(body.text).toContain('&lt;Evil&gt;');
    expect(body.text).toContain('A&amp;B');
    expect(body.text).toContain('&quot;Founder&quot;');
    expect(body.text).not.toContain('<Evil>');
  });

  it('truncates snippet to 200 characters', async () => {
    mockFetchOk();

    const longSnippet = 'x'.repeat(300);

    await notifyLeadReply({
      ...BASE_INPUT,
      reply: { ...BASE_INPUT.reply, snippet: longSnippet },
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, string>;
    // snippet is escaped then appears quoted; check the 'x' run is ≤200 chars
    expect(body.text).toContain('x'.repeat(200));
    expect(body.text).not.toContain('x'.repeat(201));
  });

  it('uses null-safe fallbacks for missing lead fields', async () => {
    mockFetchOk();

    await notifyLeadReply({
      lead: { id: 'x', name: null, company: null, title: null },
      reply: BASE_INPUT.reply,
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, string>;
    expect(body.text).toContain('Unknown');
  });

  // ─── Retry logic ─────────────────────────────────────────────────────────

  it('logs the first failure with willRetry: true and retries once on success', async () => {
    // First call fails, second succeeds
    mockFetchFail(500, 'Server Error');
    mockFetchOk();

    await expect(notifyLeadReply(BASE_INPUT)).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(logJob).toHaveBeenCalledWith(
      'reply-detection',
      'error',
      expect.objectContaining({
        step: 'notify',
        leadId: BASE_INPUT.lead.id,
        attempt: 1,
        maxAttempts: 2,
        willRetry: true,
      }),
    );
  });

  it('throws on second rejection so the caller can log the final failure', async () => {
    mockFetchFail(500, 'Server Error');
    mockFetchFail(500, 'Server Error');

    await expect(notifyLeadReply(BASE_INPUT)).rejects.toThrow('Telegram API error 500');

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry when TELEGRAM_BOT_TOKEN is absent (soft-skip path)', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(notifyLeadReply(BASE_INPUT)).resolves.toBeUndefined();

    // fetch never called, logJob never called for retry
    expect(mockFetch).not.toHaveBeenCalled();
    expect(logJob).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
