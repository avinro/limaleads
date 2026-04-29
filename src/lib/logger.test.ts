import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getSupabaseClient } from '../db/client';
import { logJob } from './logger';

vi.mock('../db/client', () => ({
  getSupabaseClient: vi.fn(),
}));

describe('logJob', () => {
  const getSupabaseClientMock = vi.mocked(getSupabaseClient);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes a job log row to Supabase', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ insert });

    getSupabaseClientMock.mockReturnValue({ from } as never);

    await logJob('apollo-poller', 'started', { attempt: 1 });

    expect(from).toHaveBeenCalledWith('job_log');
    expect(insert).toHaveBeenCalledWith({
      job_type: 'apollo-poller',
      status: 'started',
      details: { attempt: 1 },
    });
  });

  it('does not throw when Supabase insert rejects', async () => {
    const error = new Error('database unavailable');
    const insert = vi.fn().mockRejectedValue(error);
    const from = vi.fn().mockReturnValue({ insert });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    getSupabaseClientMock.mockReturnValue({ from } as never);

    await expect(logJob('apollo-poller', 'error')).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith('Failed to write job log:', error);

    consoleError.mockRestore();
  });
});
