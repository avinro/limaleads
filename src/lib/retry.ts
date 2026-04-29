import { isTransientError, serializeError } from './errors';
import { logJob } from './logger';

export interface RetryOptions {
  maxAttempts: number;
  backoffMs: number;
  jobType: string;
}

function validateRetryOptions(options: RetryOptions): void {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error('maxAttempts must be an integer greater than 0');
  }

  if (!Number.isFinite(options.backoffMs) || options.backoffMs < 0) {
    throw new Error('backoffMs must be a non-negative number');
  }

  if (!options.jobType) {
    throw new Error('jobType is required');
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runWithRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  validateRetryOptions(options);

  const { backoffMs, jobType, maxAttempts } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await logJob(jobType, 'started', { attempt, maxAttempts });

    try {
      const result = await fn();

      await logJob(jobType, 'success', { attempt, maxAttempts });

      return result;
    } catch (error) {
      const transient = isTransientError(error);
      const willRetry = transient && attempt < maxAttempts;

      await logJob(jobType, 'error', {
        attempt,
        error: serializeError(error),
        maxAttempts,
        transient,
        willRetry,
      });

      if (!willRetry) {
        throw error;
      }

      await wait(backoffMs * 2 ** (attempt - 1));
    }
  }

  throw new Error('runWithRetry exhausted all attempts without returning or throwing');
}
