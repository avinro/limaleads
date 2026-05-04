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

// 2026-05-01T17:00:00.000Z → Europe/Madrid CEST (UTC+2) = 19:00 = 7:00 PM
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

  // ─── Layout ───────────────────────────────────────────────────────────────

  it('renders Lead replied: on its own line, then identity, then timestamp', async () => {
    mockFetchOk();

    await notifyLeadReply(BASE_INPUT);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    const lines = (body.text as string).split('\n');

    expect(lines[0]).toBe('<b>Lead replied:</b>');
    expect(lines[1]).toContain('John Lead');
    expect(lines[1]).toContain('CEO');
    expect(lines[1]).toContain('Acme Corp');
    expect(lines[2]).toMatch(/^<i>.+<\/i>$/);
    expect(lines[3]).toBe('');
    expect(lines[4]).toContain('"Thanks for reaching out!"');
  });

  // ─── Happy path ──────────────────────────────────────────────────────────

  it('sends a single HTML message with escaped lead fields, snippet, link, and timestamp', async () => {
    mockFetchOk();

    await notifyLeadReply(BASE_INPUT);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/sendMessage');

    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.parse_mode).toBe('HTML');

    const text = body.text as string;
    expect(text).toContain('John Lead');
    expect(text).toContain('CEO');
    expect(text).toContain('Acme Corp');
    expect(text).toContain('Thanks for reaching out!');
    // 2026-05-01T17:00:00Z in Europe/Madrid CEST (UTC+2) = 19:00 = 7:00 PM
    expect(text).toContain('2026-05-01 · 7:00 PM');

    // Gmail link lives in the inline keyboard button, not in the message text
    const replyMarkup = body.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; url: string }>>;
    };
    expect(replyMarkup.inline_keyboard[0][0].url).toContain('mail.google.com/mail/u/0/#all/');
    expect(replyMarkup.inline_keyboard[0][0].url).toContain(encodeURIComponent('thread-abc'));
    expect(replyMarkup.inline_keyboard[0][0].text).toBe('📬 Open in Gmail');
  });

  it('HTML-escapes special characters in lead fields', async () => {
    mockFetchOk();

    await notifyLeadReply({
      ...BASE_INPUT,
      lead: { id: 'x', name: '<Evil>', company: 'A&B', title: '"Founder"' },
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    const text = body.text as string;
    expect(text).toContain('&lt;Evil&gt;');
    expect(text).toContain('A&amp;B');
    expect(text).toContain('&quot;Founder&quot;');
    expect(text).not.toContain('<Evil>');
  });

  it('truncates snippet to 200 characters', async () => {
    mockFetchOk();

    const longSnippet = 'x'.repeat(300);

    await notifyLeadReply({
      ...BASE_INPUT,
      reply: { ...BASE_INPUT.reply, snippet: longSnippet },
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    const text = body.text as string;
    // snippet is escaped then appears quoted; check the 'x' run is ≤200 chars
    expect(text).toContain('x'.repeat(200));
    expect(text).not.toContain('x'.repeat(201));
  });

  it('uses null-safe fallbacks for missing lead fields', async () => {
    mockFetchOk();

    await notifyLeadReply({
      lead: { id: 'x', name: null, company: null, title: null },
      reply: BASE_INPUT.reply,
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.text as string).toContain('Unknown');
  });

  // ─── Timestamp formatting ─────────────────────────────────────────────────

  it('formats repliedAt in Europe/Madrid — CET (winter, UTC+1)', async () => {
    mockFetchOk();

    // 2026-01-15T10:00:00Z → CET (UTC+1) = 11:00 AM
    await notifyLeadReply({
      ...BASE_INPUT,
      reply: { ...BASE_INPUT.reply, repliedAt: new Date('2026-01-15T10:00:00.000Z') },
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.text as string).toContain('2026-01-15 · 11:00 AM');
  });

  it('formats repliedAt in Europe/Madrid — CEST (summer, UTC+2)', async () => {
    mockFetchOk();

    // 2026-07-15T10:00:00Z → CEST (UTC+2) = 12:00 PM
    await notifyLeadReply({
      ...BASE_INPUT,
      reply: { ...BASE_INPUT.reply, repliedAt: new Date('2026-07-15T10:00:00.000Z') },
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.text as string).toContain('2026-07-15 · 12:00 PM');
  });

  // ─── Snippet cleanup ──────────────────────────────────────────────────────

  it('strips quoted Spanish thread history (real Gmail snippet shape)', async () => {
    mockFetchOk();

    // Exact shape from production: entities + "El ... escribió:" separator
    const rawSnippet =
      'Hey I love the idea. Let&#39;s work together. El lun, 4 may 2026 a las 12:23, Ary Vincench (&lt;avinroart@gmail.com&gt;) escribió: Hi Elena Martínez, Just following up on my note about fashion-level';

    await notifyLeadReply({
      ...BASE_INPUT,
      reply: { ...BASE_INPUT.reply, snippet: rawSnippet },
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    const text = body.text as string;

    // Only the lead's actual reply should appear
    expect(text).toContain("Hey I love the idea. Let's work together.");
    expect(text).not.toContain('escribi');
    expect(text).not.toContain('Just following up');
    expect(text).not.toContain('avinroart@gmail.com');
  });

  it('strips quoted English thread history (On ... wrote: pattern)', async () => {
    mockFetchOk();

    const rawSnippet =
      'Sounds great! On Mon, 4 May 2026 at 10:23, Ary Vincench <ary@example.com> wrote: Hi there, just reaching out to say hello.';

    await notifyLeadReply({
      ...BASE_INPUT,
      reply: { ...BASE_INPUT.reply, snippet: rawSnippet },
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    const text = body.text as string;

    expect(text).toContain('Sounds great!');
    expect(text).not.toContain('reaching out to say hello');
  });

  it('falls back to decoded snippet when stripping removes everything (bottom-posting)', async () => {
    mockFetchOk();

    // Snippet starts with the separator — stripping leaves nothing
    const rawSnippet =
      'On Mon, 4 May 2026 at 10:23, Ary Vincench <ary@example.com> wrote: Let them reply below this line.';

    await notifyLeadReply({
      ...BASE_INPUT,
      reply: { ...BASE_INPUT.reply, snippet: rawSnippet },
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    const text = body.text as string;

    // Message must not show empty quotes — fallback keeps the full decoded text
    expect(text).not.toMatch(/""\s*\n/);
    expect(text).toContain('On Mon');
  });

  it('decodes numeric HTML entities (&#34;) and &nbsp; in the snippet', async () => {
    mockFetchOk();

    await notifyLeadReply({
      ...BASE_INPUT,
      reply: {
        ...BASE_INPUT.reply,
        snippet: 'Hello&#34;world&#34; and&nbsp;more',
      },
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    const text = body.text as string;

    // &#34; is a double-quote → htmlEscape'd to &quot; in Telegram HTML
    expect(text).toContain('Hello&quot;world&quot;');
    // &nbsp; becomes a regular space → normalized
    expect(text).toContain('and more');
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
