const TRANSIENT_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

const TRANSIENT_MESSAGE_PATTERNS = ['fetch failed', 'network', 'timeout', 'timed out'];
const PERMANENT_MESSAGE_PATTERNS = ['auth', 'unauthorized', 'forbidden', 'validation'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const property = value[key];

  return typeof property === 'string' ? property : undefined;
}

function readNumberProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const property = value[key];

  return typeof property === 'number' ? property : undefined;
}

function getStatus(error: unknown): number | undefined {
  return (
    readNumberProperty(error, 'status') ??
    readNumberProperty(error, 'statusCode') ??
    readNumberProperty(error, 'httpStatus')
  );
}

function getMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return readStringProperty(error, 'message') ?? '';
}

export function isTransientError(error: unknown): boolean {
  const status = getStatus(error);

  if (status !== undefined) {
    return status === 429 || status >= 500;
  }

  const code = readStringProperty(error, 'code');

  if (code && TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }

  const message = getMessage(error).toLowerCase();

  if (PERMANENT_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern))) {
    return false;
  }

  return TRANSIENT_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern));
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      message: error.message,
      name: error.name,
    };

    const code = readStringProperty(error, 'code');
    const status = getStatus(error);

    if (code) {
      serialized.code = code;
    }

    if (status !== undefined) {
      serialized.status = status;
    }

    return serialized;
  }

  if (isRecord(error)) {
    return { ...error };
  }

  return {
    message: String(error),
  };
}
