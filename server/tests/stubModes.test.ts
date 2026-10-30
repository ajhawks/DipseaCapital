/**
 * The real HTTP adapter against the Silexx stub, one test per stub mode,
 * asserting the R-VERIFY state the trader would see (S1.4 acceptance).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { HandoffState, OrderFields } from '@silexx/shared';
import { confirmDraft, createDrafts } from '../src/services/drafts/draftService.js';
import { HttpSilexxAdapter } from '../src/services/handoff/httpAdapter.js';
import { setAdapter, startHandoff } from '../src/services/handoff/handoffService.js';
import { setStore, Store } from '../src/services/store/store.js';

const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
let stub: ChildProcess;

beforeAll(async () => {
  stub = spawn(process.execPath, [join(process.cwd(), 'scripts/silexx-stub.mjs')], {
    env: { ...process.env, STUB_PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/__mode`, { method: 'POST', body: '{"mode":"ok"}' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('stub did not start');
});

afterAll(() => {
  stub.kill();
});

const ORDER: OrderFields = { side: 'SELL', quantity: 25, symbol: 'MSFT', orderType: 'STOP_LIMIT', stopPrice: 400, limitPrice: 399.5, assetClass: 'EQUITY' };
const FULL = { idempotency: true, lookup: true, readBack: true };

async function handoffIn(mode: string, caps = FULL): Promise<HandoffState> {
  setStore(new Store());
  await fetch(`${BASE}/__mode`, { method: 'POST', body: JSON.stringify({ mode }) });
  setAdapter(new HttpSilexxAdapter(BASE, 'stub-key', 500, caps));
  const [d] = await createDrafts('alice', [{ fields: ORDER, rawSymbol: 'MSFT' }]);
  const c = await confirmDraft('alice', d!.id, d!.version);
  const h = (await startHandoff('alice', c.id, c.version)).handoff;
  return h.state;
}

// Every row names its capabilities: a short row makes Jest pass `done` as the last argument.
const NO_LOOKUP = { idempotency: true, lookup: false, readBack: false };
const CASES: [mode: string, expected: HandoffState, caps: typeof FULL][] = [
  ['ok', 'populated_verified', FULL],
  ['ok-without-lookup', 'populated_unverified', NO_LOOKUP],
  ['reject', 'failed_known', FULL],
  ['timeout-after-accept', 'uncertain', FULL],
  ['5xx', 'uncertain', FULL],
  ['2xx-malformed', 'uncertain', FULL],
  ['2xx-missing-ticket-id', 'uncertain', FULL],
  ['read-back-mismatch', 'mismatch', FULL],
  ['read-back-submitted', 'safety_violation', FULL],
];

it.each(CASES)('stub mode %s → %s', async (mode, expected, caps) => {
  expect(await handoffIn(mode, caps)).toBe(expected);
});

it('connection refused before sending → failed_known (definitely not created)', async () => {
  setStore(new Store());
  // A port that was free a moment ago: nothing is listening, so the connection is refused.
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  setAdapter(new HttpSilexxAdapter(`http://127.0.0.1:${port}`, 'k', 500, FULL));
  const [d] = await createDrafts('alice', [{ fields: ORDER, rawSymbol: 'MSFT' }]);
  const c = await confirmDraft('alice', d!.id, d!.version);
  expect((await startHandoff('alice', c.id, c.version)).handoff.state).toBe('failed_known');
});
