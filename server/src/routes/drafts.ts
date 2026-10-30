import { Router, type NextFunction, type Response } from 'express';
import type {
  AcknowledgeRequest,
  ApiError,
  DraftListResponse,
  DraftResponse,
  EditDraftRequest,
  OrderDraft,
  ReconcileRequest,
} from '@silexx/shared';
import { draftRateLimiter } from '../middleware/rateLimiter.js';
import {
  acknowledgeWarnings,
  cancelDraft,
  confirmDraft,
  DraftError,
  editDraft,
  getDraft,
  listDrafts,
} from '../services/drafts/draftService.js';
import { getAvailability, reconcile, startHandoff } from '../services/handoff/handoffService.js';

const router = Router();

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const versionOf = (body: unknown): number | undefined =>
  isObject(body) && Number.isInteger(body['version']) ? (body['version'] as number) : undefined;

function badRequest(res: Response, message: string): void {
  const body: ApiError = { error: message, code: 'INVALID_REQUEST' };
  res.status(400).json(body);
}

async function respond(res: Response, next: NextFunction, work: () => Promise<OrderDraft>): Promise<void> {
  try {
    const body: DraftResponse = { draft: await work() };
    res.json(body);
  } catch (err) {
    if (err instanceof DraftError) {
      const body: ApiError = { error: err.message, code: err.code };
      if (err.draft) body.draft = err.draft;
      res.status(err.status).json(body);
      return;
    }
    next(err);
  }
}

router.get('/', async (req, res, next) => {
  try {
    const body: DraftListResponse = { drafts: await listDrafts(req.userId as string) };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

router.get('/handoff-availability', async (_req, res, next) => {
  try {
    res.json(await getAvailability());
  } catch (err) {
    next(err);
  }
});

router.get('/:id', (req, res, next) => respond(res, next, () => getDraft(req.userId as string, req.params['id'] as string)));

router.patch('/:id', (req, res, next) => {
  const version = versionOf(req.body);
  const changes = isObject(req.body) ? req.body['changes'] : undefined;
  if (version === undefined || !isObject(changes)) return badRequest(res, 'version and changes are required');
  return respond(res, next, () =>
    editDraft(req.userId as string, req.params['id'] as string, version, changes as EditDraftRequest['changes']),
  );
});

router.post('/:id/acknowledge', (req, res, next) => {
  const version = versionOf(req.body);
  const codes = isObject(req.body) ? req.body['codes'] : undefined;
  if (version === undefined || !Array.isArray(codes) || !codes.every((c) => typeof c === 'string')) {
    return badRequest(res, 'version and codes[] are required');
  }
  return respond(res, next, () =>
    acknowledgeWarnings(req.userId as string, req.params['id'] as string, version, codes as AcknowledgeRequest['codes']),
  );
});

router.post('/:id/confirm', (req, res, next) => {
  const version = versionOf(req.body);
  if (version === undefined) return badRequest(res, 'version is required');
  return respond(res, next, () => confirmDraft(req.userId as string, req.params['id'] as string, version));
});

router.post('/:id/cancel', (req, res, next) => {
  const version = versionOf(req.body);
  if (version === undefined) return badRequest(res, 'version is required');
  return respond(res, next, () => cancelDraft(req.userId as string, req.params['id'] as string, version));
});

router.post('/:id/handoff', draftRateLimiter, (req, res, next) => {
  const version = versionOf(req.body);
  if (version === undefined) return badRequest(res, 'version is required');
  return respond(res, next, () => startHandoff(req.userId as string, req.params['id'] as string, version));
});

router.post('/:id/reconcile', (req, res, next) => {
  const manual = isObject(req.body) ? req.body['manualResult'] : undefined;
  if (manual !== undefined && manual !== 'present_correct' && manual !== 'absent' && manual !== 'wrong') {
    return badRequest(res, 'manualResult must be present_correct, absent or wrong');
  }
  return respond(res, next, () =>
    reconcile(req.userId as string, req.params['id'] as string, manual as ReconcileRequest['manualResult']),
  );
});

export default router;
