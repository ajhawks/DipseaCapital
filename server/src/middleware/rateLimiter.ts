import rateLimit from 'express-rate-limit';
import type { ParseErrorResponse } from '@silexx/shared';

function makeRateLimitHandler(windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    max,
    // Key per authenticated user; falls back to IP if userId not yet set (should not happen).
    keyGenerator: (req) => req.userId ?? req.ip ?? 'unknown',
    handler: (_req, res) => {
      const body: ParseErrorResponse = {
        error: 'Too many requests. Please try again later.',
        code: 'RATE_LIMITED',
      };
      res.status(429).json(body);
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => false,
  });
}

/** 10 requests per minute per user on POST /api/parse */
export const parseRateLimiter = makeRateLimitHandler(60 * 1000, 10);

/** 5 requests per minute per user on POST /api/draft */
export const draftRateLimiter = makeRateLimitHandler(60 * 1000, 5);
