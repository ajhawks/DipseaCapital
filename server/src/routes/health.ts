import { Router } from 'express';

const router = Router();

router.get('/', (_req, res): void => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
