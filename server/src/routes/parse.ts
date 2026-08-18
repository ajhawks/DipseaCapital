import { randomUUID } from 'crypto';
import { Router } from 'express';
import type {
  OrderDraft,
  OrderSide,
  OrderType,
  ParseErrorResponse,
  ParsedOrder,
  ParseRequest,
  ParseResponse,
} from '@silexx/shared';
import { parseRateLimiter } from '../middleware/rateLimiter.js';
import { auditService } from '../services/audit/auditService.js';
import { interpretWithNLP } from '../services/nlp/index.js';
import { ParseError, parseTranscript } from '../services/parser/index.js';

const router = Router();

function isParseRequest(body: unknown): body is ParseRequest {
  return (
    typeof body === 'object' &&
    body !== null &&
    'transcript' in body &&
    typeof (body as { transcript: unknown }).transcript === 'string'
  );
}

// Converts a fully-parsed ParsedOrder into a reviewable OrderDraft.
// Type assertions are safe: parseTranscript throws ParseError if any required
// field is absent, so all required fields are guaranteed to be defined here.
function buildOrderDraft(
  id: string,
  createdAt: string,
  transcriptFragment: string,
  parsed: ParsedOrder,
): OrderDraft {
  const draft: OrderDraft = {
    id,
    status: 'draft',
    createdAt,
    transcriptFragment,
    side: parsed.side as OrderSide,
    quantity: parsed.quantity as number,
    symbol: (parsed.resolvedSymbol ?? parsed.rawSymbol) as string,
    rawSymbol: parsed.rawSymbol as string,
    orderType: parsed.orderType as OrderType,
    assetClass: parsed.assetClass ?? 'EQUITY',
  };
  if (parsed.limitPrice !== undefined) draft.limitPrice = parsed.limitPrice;
  if (parsed.stopPrice !== undefined) draft.stopPrice = parsed.stopPrice;
  return draft;
}

router.post('/', parseRateLimiter, async (req, res, next): Promise<void> => {
  const userId = req.userId ?? 'unknown';

  if (!isParseRequest(req.body) || req.body.transcript.trim().length === 0) {
    const body: ParseErrorResponse = {
      error: 'transcript is required and must be a non-empty string',
      code: 'PARSE_FAILED',
    };
    res.status(400).json(body);
    return;
  }

  const { transcript, symbolOverride } = req.body;

  try {
    await auditService.log({
      userId,
      action: 'PARSE_REQUEST',
      metadata: { transcriptLength: transcript.length },
    });

    const useNlp = process.env['ENABLE_NLP'] === 'true';
    const parsed = useNlp
      ? await interpretWithNLP(transcript, symbolOverride)
      : parseTranscript(transcript);

    const id = randomUUID();
    const draft = buildOrderDraft(id, new Date().toISOString(), transcript, parsed);

    // Strip transcriptFragment before auditing — raw voice content must not be
    // stored persistently without compliance sign-off (§8.4).
    const { transcriptFragment: _transcriptFragment, ...parsedFields } = draft;
    await auditService.log({ userId, action: 'PARSE_SUCCESS', orderId: id, parsedFields });

    const response: ParseResponse = { draft };
    res.json(response);
  } catch (err) {
    if (err instanceof ParseError) {
      try {
        await auditService.log({ userId, action: 'PARSE_FAILURE', errorCode: err.code });
      } catch {
        // Audit failure must not suppress the parse error response.
      }

      const body: ParseErrorResponse = { error: err.message, code: err.code };
      if (err.missingFields !== undefined) body.missingFields = err.missingFields;
      if (err.candidates !== undefined) body.candidates = err.candidates;
      res.status(422).json(body);
      return;
    }

    // Unexpected error (NLP stub not implemented, I/O failure, etc.) → 500.
    try {
      await auditService.log({ userId, action: 'PARSE_FAILURE', errorCode: 'PARSE_FAILED' });
    } catch {
      // Best effort — do not mask the original error.
    }
    next(err);
  }
});

export default router;
