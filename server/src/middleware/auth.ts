import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';

interface JwtPayload {
  userId: string;
  iat?: number;
  exp?: number;
}

export const authMiddleware: RequestHandler = (req, res, next): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header', code: 'UNAUTHORIZED' });
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env['JWT_SECRET'];

  if (!secret) {
    res.status(500).json({ error: 'Server configuration error', code: 'SERVER_ERROR' });
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as JwtPayload;
    // Fail closed: a valid signature without an identity is not an identity.
    if (typeof payload.userId !== 'string' || payload.userId.trim() === '') {
      res.status(401).json({ error: 'Token has no user identity', code: 'UNAUTHORIZED' });
      return;
    }
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
  }
};
