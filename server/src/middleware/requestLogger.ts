import type { RequestHandler } from 'express';

const REDACTED_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie']);

export const requestLogger: RequestHandler = (req, res, next): void => {
  const start = Date.now();

  // Collect safe headers — strip any that may contain secrets.
  const safeHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!REDACTED_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
      safeHeaders[key] = value;
    }
  }

  res.on('finish', () => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
        userId: req.userId,
        headers: safeHeaders,
      }),
    );
  });

  next();
};
