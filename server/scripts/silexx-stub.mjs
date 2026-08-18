/**
 * Local stand-in for the Silexx sandbox API. Lets the full voice-to-draft
 * flow run end-to-end before real credentials are wired in.
 *
 * Usage:
 *   node scripts/silexx-stub.mjs            # listens on :4010
 *   STUB_PORT=5000 node scripts/silexx-stub.mjs
 *
 * Then in .env:
 *   SILEXX_API_URL=http://localhost:4010
 *   SILEXX_API_KEY=stub-key
 */
import http from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 4010);
const API_KEY = process.env.STUB_API_KEY ?? 'stub-key';

const seenDraftIds = new Set();
let ticketCounter = 0;

const server = http.createServer((req, res) => {
  const respond = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'POST' || req.url !== '/orders/draft') {
    return respond(404, { error: 'Not found' });
  }
  if (req.headers['x-api-key'] !== API_KEY) {
    return respond(401, { error: 'Invalid API key' });
  }

  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let draft;
    try {
      draft = JSON.parse(raw);
    } catch {
      return respond(400, { error: 'Invalid JSON' });
    }
    if (seenDraftIds.has(draft.id)) {
      return respond(409, { error: 'Duplicate draft ID' });
    }
    seenDraftIds.add(draft.id);
    ticketCounter += 1;
    const silexxTicketId = `STUB-${String(ticketCounter).padStart(4, '0')}`;
    console.log(
      `[silexx-stub] draft ${draft.id} -> ${silexxTicketId} ` +
        `(${draft.side} ${draft.quantity} ${draft.symbol} ${draft.orderType})`,
    );
    respond(200, { silexxTicketId });
  });
});

server.listen(PORT, () => {
  console.log(`[silexx-stub] listening on http://localhost:${PORT} (key: ${API_KEY})`);
});
