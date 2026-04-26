export class WpsyncError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class AuthError extends WpsyncError {
  constructor(message = 'Authentication failed', options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class TransportError extends WpsyncError {
  readonly status: number | undefined;

  constructor(message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.status = opts.status;
  }
}

export class UsageError extends WpsyncError {}

export class ConflictError extends WpsyncError {
  readonly slugs: string[];

  constructor(slugs: string[]) {
    super(`Conflict on: ${slugs.join(', ')}`);
    this.slugs = slugs;
  }
}
