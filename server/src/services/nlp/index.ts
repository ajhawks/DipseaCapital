import type {
  AssetClass,
  OrderDraft,
  OrderSide,
  OrderType,
  ParsedOrder,
} from '@silexx/shared';
import { ParseError } from '../parser/index.js';
import { resolveSymbol } from '../symbols/symbolTable.js';

/**
 * Iteration 2 NLP layer (DESIGN.md §6.4, docs/adr/001-local-llm-nlp.md).
 *
 * Interprets a free-form spoken order using a local, OpenAI-compatible LLM
 * endpoint (Ollama / LM Studio / llama.cpp). Only reached when ENABLE_NLP=true.
 *
 * Returns a fully-populated ParsedOrder or throws ParseError on any recoverable
 * problem (missing fields / ambiguous symbol / low confidence / bad model output),
 * which the parse route maps to a 422. Config is read from the repo-root .env.
 */

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_MODEL = 'llama3.1:8b';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_CONFIDENCE = 0.6;

const SYSTEM_PROMPT = `You extract structured stock order tickets from a trader's spoken instruction.
Return ONLY a JSON object with these fields:
  "side": "BUY" | "SELL"                     (required)
  "quantity": integer number of shares        (required)
  "symbol": the ticker OR spoken company name  (required, as heard)
  "orderType": "MARKET" | "LIMIT" | "STOP"     (required)
  "limitPrice": number                         (only for LIMIT)
  "stopPrice": number                          (only for STOP)
  "confidence": number between 0 and 1         (your confidence in the extraction)
Rules:
- Do not invent values. If a field was not clearly stated, use null for that field.
- "side" must come from an explicit buying word (buy, purchase, grab, pick up, get, add)
  or selling word (sell, unload, dump, get rid of). If the instruction states neither,
  "side" MUST be null — never assume a direction. A statement like "100 shares of AAPL
  at 195" has side null.
- Never guess a ticker; put the company name exactly as spoken in "symbol".
- "at market"/"at the market" means MARKET. "at <price>" means LIMIT with that limitPrice.
  A stop or stop-loss means STOP with that stopPrice.
- Convert spoken numbers to digits ("two hundred" -> 200).
- Output the JSON object and nothing else.

Examples:
Input: "buy 100 shares of AAPL at 195.50"
Output: {"side":"BUY","quantity":100,"symbol":"AAPL","orderType":"LIMIT","limitPrice":195.50,"stopPrice":null,"confidence":0.98}
Input: "unload two hundred Tesla at the market"
Output: {"side":"SELL","quantity":200,"symbol":"Tesla","orderType":"MARKET","limitPrice":null,"stopPrice":null,"confidence":0.95}
Input: "100 shares of AAPL at 195"
Output: {"side":null,"quantity":100,"symbol":"AAPL","orderType":"LIMIT","limitPrice":195,"stopPrice":null,"confidence":0.9}
Input: "buy some Apple at market"
Output: {"side":"BUY","quantity":null,"symbol":"Apple","orderType":"MARKET","limitPrice":null,"stopPrice":null,"confidence":0.9}
Input: "can you sell 20 shares of Intel at 42.10 for me"
Output: {"side":"SELL","quantity":20,"symbol":"Intel","orderType":"LIMIT","limitPrice":42.10,"stopPrice":null,"confidence":0.95}`;

interface RawLlmOrder {
  side?: unknown;
  quantity?: unknown;
  symbol?: unknown;
  orderType?: unknown;
  limitPrice?: unknown;
  stopPrice?: unknown;
  confidence?: unknown;
}

function num(env: string | undefined, fallback: number): number {
  const n = env !== undefined ? Number(env) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

async function callLlm(transcript: string): Promise<RawLlmOrder> {
  const baseUrl = process.env['LLM_BASE_URL'] ?? DEFAULT_BASE_URL;
  const model = process.env['LLM_MODEL'] ?? DEFAULT_MODEL;
  const timeoutMs = num(process.env['LLM_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: transcript },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timed out' : 'unreachable';
    throw new ParseError('PARSE_FAILED', `NLP service ${reason}. Please try again.`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new ParseError('PARSE_FAILED', `NLP service returned ${res.status}. Please try again.`);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new ParseError('PARSE_FAILED', 'NLP service returned an invalid response.');
  }

  const content = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
    ?.message?.content;
  if (typeof content !== 'string') {
    throw new ParseError('PARSE_FAILED', 'NLP service returned no content.');
  }

  try {
    return JSON.parse(content) as RawLlmOrder;
  } catch {
    throw new ParseError('PARSE_FAILED', 'Could not understand the order. Please rephrase.');
  }
}

function normalizeSide(value: unknown): OrderSide | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toUpperCase();
  return v === 'BUY' || v === 'SELL' ? v : undefined;
}

function normalizeOrderType(value: unknown): OrderType | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toUpperCase();
  return v === 'MARKET' || v === 'LIMIT' || v === 'STOP' ? v : undefined;
}

function normalizeQuantity(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '')) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

function normalizePrice(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function interpretWithNLP(
  transcript: string,
  symbolOverride?: string,
): Promise<ParsedOrder> {
  const raw = await callLlm(transcript);

  // Confidence gate.
  const minConfidence = num(process.env['LLM_MIN_CONFIDENCE'], DEFAULT_MIN_CONFIDENCE);
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : undefined;
  if (confidence !== undefined && confidence < minConfidence) {
    throw new ParseError(
      'PARSE_FAILED',
      'Not confident enough in the interpretation. Please repeat the order.',
    );
  }

  const side = normalizeSide(raw.side);
  const quantity = normalizeQuantity(raw.quantity);
  const orderType = normalizeOrderType(raw.orderType);
  const spokenSymbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : '';
  const limitPrice = normalizePrice(raw.limitPrice);
  const stopPrice = normalizePrice(raw.stopPrice);

  const missingFields: (keyof OrderDraft)[] = [];
  if (side === undefined) missingFields.push('side');
  if (quantity === undefined) missingFields.push('quantity');
  if (spokenSymbol.length === 0) missingFields.push('symbol');
  if (orderType === undefined) missingFields.push('orderType');
  else if (orderType === 'LIMIT' && limitPrice === undefined) missingFields.push('limitPrice');
  else if (orderType === 'STOP' && stopPrice === undefined) missingFields.push('stopPrice');

  if (missingFields.length > 0) {
    throw new ParseError(
      'MISSING_FIELDS',
      `Missing required fields: ${missingFields.join(', ')}.`,
      missingFields,
    );
  }

  // Resolve the ticker. An explicit user choice (post-clarification) bypasses resolution;
  // otherwise resolveSymbol throws AMBIGUOUS_SYMBOL (with candidates when applicable).
  const resolvedSymbol =
    symbolOverride !== undefined && symbolOverride.trim().length > 0
      ? symbolOverride.trim().toUpperCase()
      : resolveSymbol(spokenSymbol).symbol;

  const assetClass: AssetClass = 'EQUITY';
  const parsed: ParsedOrder = {
    side: side as OrderSide,
    quantity: quantity as number,
    rawSymbol: spokenSymbol,
    resolvedSymbol,
    orderType: orderType as OrderType,
    assetClass,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(orderType === 'LIMIT' && limitPrice !== undefined ? { limitPrice } : {}),
    ...(orderType === 'STOP' && stopPrice !== undefined ? { stopPrice } : {}),
  };
  return parsed;
}
