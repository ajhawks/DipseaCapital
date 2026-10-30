/**
 * Local stand-in for the Silexx sandbox API. Lets the full voice-to-draft flow
 * run end-to-end, and lets every R-VERIFY outcome be produced on demand.
 *
 * Usage:
 *   node scripts/silexx-stub.mjs                       # listens on :4010, mode "ok"
 *   STUB_MODE=timeout-after-accept node scripts/silexx-stub.mjs
 *   curl -XPOST localhost:4010/__mode -d '{"mode":"read-back-submitted"}'
 *
 * Then in .env:
 *   SILEXX_API_URL=http://localhost:4010
 *   SILEXX_API_KEY=stub-key
 *   SILEXX_CAPABILITIES=idempotency,lookup,readBack
 *
 * Modes:
 *   ok                     accept, lookup + read-back work
 *   ok-without-lookup      accept, lookup returns 501
 *   reject                 422 validation rejection (definitely not created)
 *   timeout-after-accept   store the ticket, then never answer
 *   5xx                    store the ticket, then return 503
 *   2xx-malformed          store the ticket, return non-JSON 200
 *   2xx-missing-ticket-id  store the ticket, return 200 {}
 *   read-back-mismatch     accept, but read-back shows a different quantity
 *   read-back-submitted    accept, but read-back shows the ticket as submitted
 */
import http from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 4010);
const API_KEY = process.env.STUB_API_KEY ?? 'stub-key';
const MODES = new Set([
  'ok', 'ok-without-lookup', 'reject', 'timeout-after-accept', '5xx',
  '2xx-malformed', '2xx-missing-ticket-id', 'read-back-mismatch', 'read-back-submitted',
]);

let mode = process.env.STUB_MODE ?? 'ok';
/** idempotencyKey -> { silexxTicketId, fields, status } */
const tickets = new Map();
let ticketCounter = 0;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

const server = http.createServer(async (req, res) => {
  const respond = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'POST' && url.pathname === '/__mode') {
    const { mode: next } = JSON.parse((await readBody(req)) || '{}');
    if (!MODES.has(next)) return respond(400, { error: `unknown mode ${next}` });
    mode = next;
    console.log(`[silexx-stub] mode -> ${mode}`);
    return respond(200, { mode });
  }
  if (req.headers['x-api-key'] !== API_KEY) return respond(401, { error: 'Invalid API key' });

  if (req.method === 'GET' && url.pathname === '/orders/draft') {
    if (mode === 'ok-without-lookup') return respond(501, { error: 'lookup not supported' });
    const t = tickets.get(url.searchParams.get('idempotencyKey'));
    if (!t) return respond(404, { error: 'not found' });
    const fields = mode === 'read-back-mismatch' ? { ...t.fields, quantity: t.fields.quantity + 1 } : t.fields;
    const status = mode === 'read-back-submitted' ? 'submitted' : t.status;
    return respond(200, { silexxTicketId: t.silexxTicketId, fields, status });
  }

  if (req.method !== 'POST' || url.pathname !== '/orders/draft') return respond(404, { error: 'Not found' });

  let fields;
  try {
    fields = JSON.parse(await readBody(req));
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }
  if (mode === 'reject') return respond(422, { error: 'Rejected by stub' });

  const key = req.headers['idempotency-key'];
  // Idempotency: the same key returns the same ticket instead of creating a second one.
  let t = typeof key === 'string' ? tickets.get(key) : undefined;
  if (!t) {
    ticketCounter += 1;
    t = { silexxTicketId: `STUB-${String(ticketCounter).padStart(4, '0')}`, fields, status: 'draft' };
    if (typeof key === 'string') tickets.set(key, t);
    console.log(`[silexx-stub] ${t.silexxTicketId} <- ${fields.side} ${fields.quantity} ${fields.symbol} ${fields.orderType} (mode ${mode})`);
  }

  switch (mode) {
    case 'timeout-after-accept':
      return; // never answer
    case '5xx':
      return respond(503, { error: 'Service unavailable' });
    case '2xx-malformed':
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"silexxTicketId": ');
    case '2xx-missing-ticket-id':
      return respond(200, {});
    default:
      return respond(200, { silexxTicketId: t.silexxTicketId, idempotencyKey: key });
  }
});

server.listen(PORT, () => {
  console.log(`[silexx-stub] listening on http://localhost:${PORT} (key: ${API_KEY}, mode: ${mode})`);
});
