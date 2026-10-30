import { Router } from 'express';
import type {
  ApiError,
  Clarification,
  OrderFields,
  ParsedOrder,
  ParseRequest,
  ParseResponse,
  Refusal,
} from '@silexx/shared';
import { parseRateLimiter } from '../middleware/rateLimiter.js';
import { sha256 } from '../services/audit/chain.js';
import { createDrafts } from '../services/drafts/draftService.js';
import { interpretWithNLP } from '../services/nlp/index.js';
import { ParseError, parseTranscript } from '../services/parser/index.js';
import { getStore } from '../services/store/store.js';

const router = Router();

function isParseRequest(body: unknown): body is ParseRequest {
  return (
    typeof body === 'object' &&
    body !== null &&
    'transcript' in body &&
    typeof (body as { transcript: unknown }).transcript === 'string'
  );
}

// Core scope (IMPLEMENTATION_PLAN §3): one equity order per utterance. These checks
// refuse out-of-scope input up front so nothing is part-parsed or silently dropped.
const OPTIONS_RE = /\b(calls?|puts?|strike|expir\w*|contracts?|options?)\b/i;
const SIDE_WORD_RE = /\b(buy|sell|purchase|unload|dump|short|cover)\b/gi;
const CORRECTION_RE = /\b(no wait|make that|actually|i mean|scratch that|correction)\b/i;

function coreScopeRefusal(transcript: string): Refusal | undefined {
  if (OPTIONS_RE.test(transcript)) {
    return { code: 'OPTIONS_UNSUPPORTED', message: 'Options orders are not supported yet. Nothing was drafted.' };
  }
  const sideWords = transcript.match(SIDE_WORD_RE) ?? [];
  if (sideWords.length > 1 && !CORRECTION_RE.test(transcript)) {
    return {
      code: 'MULTI_ORDER_UNSUPPORTED',
      message: `This sounds like more than one order (heard: ${sideWords.join(', ')}). Enter one order at a time. Nothing was drafted.`,
    };
  }
  return undefined;
}

// Required fields are guaranteed by the parsers: they throw ParseError otherwise.
function toFields(parsed: ParsedOrder): OrderFields {
  const fields: OrderFields = {
    side: parsed.side as OrderFields['side'],
    quantity: parsed.quantity as number,
    symbol: (parsed.resolvedSymbol ?? parsed.rawSymbol) as string,
    orderType: parsed.orderType as OrderFields['orderType'],
    assetClass: parsed.assetClass ?? 'EQUITY',
  };
  if (parsed.limitPrice !== undefined) fields.limitPrice = parsed.limitPrice;
  if (parsed.stopPrice !== undefined) fields.stopPrice = parsed.stopPrice;
  return fields;
}

router.post('/', parseRateLimiter, async (req, res, next): Promise<void> => {
  const userId = req.userId as string;

  if (!isParseRequest(req.body) || req.body.transcript.trim().length === 0) {
    const body: ApiError = { error: 'transcript is required and must be a non-empty string', code: 'INVALID_REQUEST' };
    res.status(400).json(body);
    return;
  }

  const { transcript, symbolOverride } = req.body;
  const store = getStore();
  const response: ParseResponse = { drafts: [], clarifications: [], refusals: [] };
  const transcriptMeta = { transcriptSha256: sha256(transcript), transcriptLength: transcript.length };

  try {
    await store.transaction((tx) => tx.audit({ userId, event: 'PARSE_REQUEST', data: transcriptMeta }));

    const refusal = coreScopeRefusal(transcript);
    if (refusal) {
      response.refusals.push(refusal);
      await store.transaction((tx) => tx.audit({ userId, event: 'PARSE_REFUSAL', data: { code: refusal.code } }));
      res.json(response);
      return;
    }

    let parsed: ParsedOrder;
    try {
      parsed =
        process.env['ENABLE_NLP'] === 'true'
          ? await interpretWithNLP(transcript, symbolOverride)
          : parseTranscript(transcript);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      if (err.code === 'PARSE_FAILED' && /NLP service/.test(err.message)) {
        // The approved local model is down: fail safely, never fall back to another provider.
        const body: ApiError = { error: 'The parsing service is unavailable. Your existing drafts are unaffected.', code: 'PARSER_UNAVAILABLE' };
        res.status(503).json(body);
        return;
      }
      if (err.code === 'PARSE_FAILED') {
        response.refusals.push({ code: 'PARSE_FAILED', message: err.message });
      } else {
        const c: Clarification = { code: err.code, message: err.message };
        if (err.missingFields) c.missingFields = err.missingFields.map(String);
        if (err.candidates) c.candidates = err.candidates;
        response.clarifications.push(c);
      }
      await store.transaction((tx) =>
        tx.audit({ userId, event: err.code === 'PARSE_FAILED' ? 'PARSE_REFUSAL' : 'PARSE_CLARIFICATION', data: { code: err.code } }),
      );
      res.json(response);
      return;
    }

    const fields = toFields(parsed);
    response.drafts = await createDrafts(userId, [{ fields, rawSymbol: parsed.rawSymbol ?? fields.symbol, transcript }]);
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
