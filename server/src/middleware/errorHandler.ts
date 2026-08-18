import type { ErrorRequestHandler } from 'express';
import { AppError } from '../utils/errors.js';

// Express requires exactly 4 params for error-handling middleware.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next): void => {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.missingFields !== undefined) {
      body['missingFields'] = err.missingFields;
    }
    res.status(err.statusCode).json(body);
    return;
  }

  // Log unexpected errors server-side but never expose internals to the client.
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'unhandled_error', message: String(err) }));
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
};
