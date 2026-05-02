import { AuthError, ConflictError, TransportError, UsageError } from '@wpsync/core';

export type ErrorCode = 'auth' | 'conflict' | 'transport' | 'usage' | 'other';

export interface MappedError {
  code: ErrorCode;
  message: string;
  slugs?: string[];
  status: number;
}

export function mapError(err: unknown): MappedError {
  if (err instanceof AuthError) {
    return { code: 'auth', message: err.message, status: 401 };
  }
  if (err instanceof ConflictError) {
    return { code: 'conflict', message: err.message, slugs: err.slugs, status: 409 };
  }
  if (err instanceof TransportError) {
    return { code: 'transport', message: err.message, status: 502 };
  }
  if (err instanceof UsageError) {
    return { code: 'usage', message: err.message, status: 400 };
  }
  return {
    code: 'other',
    message: err instanceof Error ? err.message : String(err),
    status: 500,
  };
}
