import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendTelegramAlert } from './telegramNotifier';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Tests
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

    mockFetch.mockResolvedValueOnce({ ok: true });

    await expect(sendTelegramAlert('pipeline error')).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/bottest-token/sendMessage');
    expect(JSON.parse(options.body as string)).toMatchObject({
      chat_id: '12345',
      text: 'pipeline error',
    });
  });

  it('throws a descriptive error on a non-2xx Telegram response', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bad-token';
    process.env.TELEGRAM_CHAT_ID = '12345';

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"description":"Unauthorized"}',
    });

    await expect(sendTelegramAlert('test')).rejects.toThrow('Telegram API error 401');
  });
});
