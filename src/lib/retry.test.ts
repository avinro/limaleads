import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logJob } from './logger';
import { runWithRetry } from './retry';

vi.mock('./logger', () => ({
  logJob: vi.fn().mockResolvedValue(undefined),
}));

describe('runWithRetry', () => {
  const logJobMock = vi.mocked(logJob);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the result and logs success when the first attempt succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(
      runWithRetry(fn, {
        backoffMs: 100,
        jobType: 'apollo-poller',
        maxAttempts: 3,
      }),
    ).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(logJobMock).toHaveBeenNthCalledWith(1, 'apollo-poller', 'started', {
      attempt: 1,
      maxAttempts: 3,
    });
    expect(logJobMock).toHaveBeenNthCalledWith(2, 'apollo-poller', 'success', {
      attempt: 1,
      maxAttempts: 3,
    });
  });

  it('retries transient errors with exponential backoff', async () => {
    vi.useFakeTimers();

    const firstError = Object.assign(new Error('network reset'), { code: 'ECONNRESET' });
    const secondError = Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError)
      .mockResolvedValue('ok');

    const result = runWithRetry(fn, {
      backoffMs: 100,
      jobType: 'apollo-poller',
      maxAttempts: 3,
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toBe('ok');

    expect(fn).toHaveBeenCalledTimes(3);
    expect(logJobMock.mock.calls.map((call) => call[1])).toEqual([
      'started',
      'error',
      'started',
      'error',
      'started',
      'success',
    ]);
    expect(logJobMock).toHaveBeenNthCalledWith(
      2,
      'apollo-poller',
      'error',
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 3,
        transient: true,
        willRetry: true,
      }),
    );
    expect(logJobMock).toHaveBeenNthCalledWith(
      4,
      'apollo-poller',
      'error',
      expect.objectContaining({
        attempt: 2,
        maxAttempts: 3,
        transient: true,
        willRetry: true,
      }),
    );
  });

  it('does not retry permanent failures', async () => {
    const error = Object.assign(new Error('Unauthorized'), { status: 401 });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(
      runWithRetry(fn, {
        backoffMs: 100,
        jobType: 'apollo-poller',
        maxAttempts: 3,
      }),
    ).rejects.toThrow('Unauthorized');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(logJobMock.mock.calls.map((call) => call[1])).toEqual(['started', 'error']);
    expect(logJobMock).toHaveBeenNthCalledWith(
      2,
      'apollo-poller',
      'error',
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 3,
        transient: false,
        willRetry: false,
      }),
    );
  });
});
