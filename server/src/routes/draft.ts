import { Router } from 'express';
import type { DraftCreateRequest, DraftCreateResponse } from '@silexx/shared';
import { draftRateLimiter } from '../middleware/rateLimiter.js';
import { auditService } from '../services/audit/auditService.js';
import { SilexxError, createDraft } from '../services/silexx/silexxClient.js';

const router = Router();

function isDraftCreateRequest(body: unknown): body is DraftCreateRequest {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b['userConfirmedAt'] !== 'string' || b['userConfirmedAt'].trim() === '') return false;
  const d = b['draft'];
  if (typeof d !== 'object' || d === null) return false;
  const draft = d as Record<string, unknown>;
  return (
    typeof draft['id'] === 'string' &&
    draft['status'] === 'draft' &&
    (draft['side'] === 'BUY' || draft['side'] === 'SELL') &&
    typeof draft['quantity'] === 'number' &&
    typeof draft['symbol'] === 'string' &&
    typeof draft['rawSymbol'] === 'string' &&
    (draft['orderType'] === 'MARKET' || draft['orderType'] === 'LIMIT' || draft['orderType'] === 'STOP') &&
    (draft['assetClass'] === 'EQUITY' || draft['assetClass'] === 'OPTION') &&
    typeof draft['createdAt'] === 'string'
  );
}

router.post('/', draftRateLimiter, async (req, res, next): Promise<void> => {
  const userId = req.userId ?? 'unknown';

  if (!isDraftCreateRequest(req.body)) {
    res.status(400).json({
      error: 'Invalid request body: draft and userConfirmedAt are required',
      code: 'INVALID_REQUEST',
    });
    return;
  }

  const { draft, userConfirmedAt } = req.body;
  const { transcriptFragment: _transcriptFragment, ...parsedFields } = draft;

  try {
    await auditService.log({
      userId,
      action: 'DRAFT_SUBMITTED',
      orderId: draft.id,
      parsedFields,
      metadata: { userConfirmedAt },
    });

    const { silexxTicketId } = await createDraft(draft, userId);

    const response: DraftCreateResponse = { silexxTicketId, status: 'created' };
    res.json(response);
  } catch (err) {
    if (err instanceof SilexxError) {
      if (err.statusCode === 409) {
        res.status(409).json({ error: 'Draft with this ID already exists', code: 'DUPLICATE_ID' });
        return;
      }
      res.status(502).json({ error: 'Silexx API unavailable, please try again', code: 'SILEXX_UNAVAILABLE' });
      return;
    }
    next(err);
  }
});

export default router;
