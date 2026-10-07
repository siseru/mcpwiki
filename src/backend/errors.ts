export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Raised by stores when a conditional write fails. */
export class ConflictError extends Error {
  constructor(message = 'conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}

export const notFound = (what = 'article') => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (message = 'forbidden') => new HttpError(403, 'forbidden', message);
export const badRequest = (message: string, details?: Record<string, unknown>) => new HttpError(400, 'bad_request', message, details);
