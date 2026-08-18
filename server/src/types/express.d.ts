declare global {
  namespace Express {
    interface Request {
      /** Populated by authMiddleware after successful JWT verification. */
      userId?: string;
    }
  }
}

export {};
