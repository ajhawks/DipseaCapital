import { test, expect, type Page, type Route } from '@playwright/test';

// ── mock API ──────────────────────────────────────────────────────────────────
// A small in-test stand-in for the server's draft lifecycle, so the UI can be
// driven through confirm / edit / handoff without a backend.

type Json = Record<string, unknown>;

const BASE_DRAFT = {
  side: 'BUY',
  quantity: 100,
  symbol: 'AAPL',
  rawSymbol: 'AAPL',
  orderType: 'LIMIT',
  limitPrice: 195.5,
  assetClass: 'EQUITY',
  contentHash: 'h1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  issues: [],
  acknowledgedWarnings: [],
  handoff: { state: 'none' },
};

interface MockOptions {
  parse?: Json;
  handoff?: Json;
  availability?: Json;
}

interface MockApi {
  calls: string[];
}

async function mockApi(page: Page, opts: MockOptions = {}): Promise<MockApi> {
  const api: MockApi = { calls: [] };
  const drafts = new Map<string, Json>();
  let seq = 0;

  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = (req.postDataJSON() ?? {}) as Json;
    const path = url.pathname;
    api.calls.push(`${req.method()} ${path}`);

    if (path === '/api/parse') {
      if (opts.parse) return route.fulfill({ json: opts.parse });
      seq += 1;
      const d = { ...BASE_DRAFT, id: `d${seq}`, version: 1, state: 'awaiting_confirmation', ...(body['symbolOverride'] ? { symbol: body['symbolOverride'] } : {}) };
      drafts.set(d.id, d);
      return route.fulfill({ json: { drafts: [d], clarifications: [], refusals: [] } });
    }
    if (path === '/api/drafts' && req.method() === 'GET') return route.fulfill({ json: { drafts: [] } });
    if (path === '/api/drafts/handoff-availability') return route.fulfill({ json: opts.availability ?? { enabled: true } });

    const m = /^\/api\/drafts\/([^/]+)(?:\/(\w+))?$/.exec(path);
    const d = m ? drafts.get(m[1] as string) : undefined;
    if (!m || !d) return route.fulfill({ status: 404, json: { error: 'Draft not found.', code: 'NOT_FOUND' } });
    if (body['version'] !== undefined && body['version'] !== d['version']) {
      return route.fulfill({ status: 409, json: { error: 'stale', code: 'STALE_VERSION', draft: d } });
    }
    const action = m[2] ?? 'edit';
    const v = (d['version'] as number) + 1;
    let next: Json = d;
    if (action === 'edit') next = { ...d, ...(body['changes'] as Json), version: v, state: 'awaiting_confirmation', confirmation: undefined, handoff: { state: 'none' } };
    if (action === 'confirm') next = { ...d, version: v, state: 'confirmed', confirmation: { version: v, contentHash: 'h1', confirmedAt: 'now' } };
    if (action === 'cancel') next = { ...d, state: 'cancelled' };
    if (action === 'handoff') {
      next = { ...d, handoff: opts.handoff ?? { state: 'populated_verified', silexxTicketId: 'STUB-0001', message: 'Populated in Silexx, fields verified. Not submitted. Review and submit in Silexx.' } };
    }
    drafts.set(d['id'] as string, next);
    return route.fulfill({ json: { draft: next } });
  });
  return api;
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function recordAndStop(page: Page, transcript: string): Promise<void> {
  await page.click('button[aria-label="Start recording"]');
  // Inject transcript text into the mock SpeechRecognition instance
  await page.evaluate((text: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setSpeechTranscript(text);
  }, transcript);
  await page.click('button[aria-label="Stop recording"]');
}

const CONFIRM = { name: 'Confirm and send draft to Silexx' };

// ── per-test setup ────────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  // Pre-seed localStorage so the JWT login form is skipped.
  await page.addInitScript((token: string) => {
    localStorage.setItem('silexx_jwt', token);
  }, 'e2e-test-jwt');

  // Replace the browser's SpeechRecognition with a controllable stub.
  // Exposes window.__setSpeechTranscript(text) which tests call to inject a
  // final transcript before clicking Stop.
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let activeInstance: any = null;

    class MockSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onresult: any = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onerror: any = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onend: any = null;

      constructor() { activeInstance = this; }
      start() {}
      // Firing onend is what the hook reacts to: it flips isRecording→false and
      // triggers submitTranscript via the useEffect in VoiceOrderPanel.
      stop() { this.onend?.(new Event('end')); }
      abort() { this.onend?.(new Event('end')); }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).SpeechRecognition = MockSpeechRecognition;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).webkitSpeechRecognition = MockSpeechRecognition;

    // Called by tests to push a final transcript into the active recognition instance.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setSpeechTranscript = (text: string) => {
      if (!activeInstance?.onresult) return;
      // Build a minimal SpeechRecognitionResultList-shaped object
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = [{ transcript: text, confidence: 1.0 }];
      result.isFinal = true;
      activeInstance.onresult({ resultIndex: 0, results: [result] });
    };
  });

});

// ── tests ─────────────────────────────────────────────────────────────────────

test('voice happy path: speak → draft card → confirm → populated and verified, not submitted', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/');
  await recordAndStop(page, 'Buy 100 shares of AAPL at 195.50');

  const card = page.getByTestId('draft-card');
  await expect(card.getByTestId('draft-badge')).toHaveText('Awaiting confirmation');
  await expect(card.getByText('Draft order to buy 100 shares of AAPL with a limit of $195.50.')).toBeVisible();
  await expect(card.getByText(/Nothing is submitted or executed by this app/)).toBeVisible();

  await card.getByRole('button', CONFIRM).click();
  await expect(card.getByTestId('draft-badge')).toHaveText('Populated, verified');
  await expect(card.getByText(/fields verified\. Not submitted/)).toBeVisible();
  expect(api.calls).toContain('POST /api/drafts/d1/confirm');
  expect(api.calls).toContain('POST /api/drafts/d1/handoff');
});

test('manual text entry drafts an order with no microphone', async ({ page }) => {
  await mockApi(page);
  await page.goto('/');
  await page.getByLabel('Order text').fill('buy 100 AAPL at 195.50');
  await page.getByRole('button', { name: 'Draft it' }).click();
  await expect(page.getByTestId('draft-badge')).toHaveText('Awaiting confirmation');
});

test('clarification: ambiguous symbol → trader picks → drafted with that symbol', async ({ page }) => {
  let parses = 0;
  await mockApi(page);
  await page.route('**/api/parse', async (route) => {
    parses += 1;
    if (parses === 1) {
      return route.fulfill({
        json: {
          drafts: [],
          refusals: [],
          clarifications: [{ code: 'AMBIGUOUS_SYMBOL', message: '"Alphabet" matches more than one ticker.', candidates: [{ symbol: 'GOOGL', name: 'Class A' }, { symbol: 'GOOG', name: 'Class C' }] }],
        },
      });
    }
    return route.fallback();
  });
  await page.goto('/');
  await page.getByLabel('Order text').fill('buy 10 Alphabet at market');
  await page.getByRole('button', { name: 'Draft it' }).click();
  await expect(page.getByTestId('clarification')).toContainText('matches more than one ticker');
  await expect(page.getByTestId('draft-card')).toHaveCount(0);
  await page.getByRole('button', { name: /GOOGL/ }).click();
  await expect(page.getByTestId('draft-card')).toContainText('GOOGL');
});

test('refusal: several orders in one utterance → nothing drafted, reason shown', async ({ page }) => {
  await mockApi(page, {
    parse: { drafts: [], clarifications: [], refusals: [{ code: 'MULTI_ORDER_UNSUPPORTED', message: 'This sounds like more than one order (heard: buy, sell). Enter one order at a time. Nothing was drafted.' }] },
  });
  await page.goto('/');
  await recordAndStop(page, 'buy 100 AAPL and sell 50 MSFT');
  await expect(page.getByTestId('refusal')).toContainText('more than one order');
  await expect(page.getByTestId('draft-card')).toHaveCount(0);
});

test('edit after confirm → card returns to Awaiting confirmation', async ({ page }) => {
  await mockApi(page, { availability: { enabled: false, reason: 'Silexx is not configured on this server.' } });
  await page.goto('/');
  await page.getByLabel('Order text').fill('buy 100 AAPL at 195.50');
  await page.getByRole('button', { name: 'Draft it' }).click();
  const card = page.getByTestId('draft-card');
  await card.getByRole('button', CONFIRM).click();
  await expect(card.getByTestId('draft-badge')).toHaveText('Confirmed · handoff disabled');

  await card.getByRole('button', { name: 'Edit' }).click();
  await card.getByLabel('Quantity').fill('250');
  await card.getByRole('button', { name: 'Save changes' }).click();
  await expect(card.getByTestId('draft-badge')).toHaveText('Awaiting confirmation');
  await expect(card.getByText(/buy 250 shares/)).toBeVisible();
});

test('uncertain handoff: says check Silexx, offers reconciliation, no blind retry', async ({ page }) => {
  await mockApi(page, { handoff: { state: 'uncertain', message: 'Silexx did not respond in time. Outcome unknown: check Silexx manually before doing anything else with this order.' } });
  await page.goto('/');
  await page.getByLabel('Order text').fill('buy 100 AAPL at 195.50');
  await page.getByRole('button', { name: 'Draft it' }).click();
  const card = page.getByTestId('draft-card');
  await card.getByRole('button', CONFIRM).click();
  await expect(card.getByTestId('draft-badge')).toHaveText('Outcome uncertain: check Silexx');
  await expect(card.getByRole('button', { name: 'Checked: not in Silexx' })).toBeVisible();
  await expect(card.getByRole('button', { name: /Try handoff again|Send draft to Silexx/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test('keyboard-only: Confirm is reachable by Tab, not auto-focused, and Enter in the text box never confirms', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/');
  const box = page.getByLabel('Order text');
  await box.fill('buy 100 AAPL at 195.50');
  await box.press('Enter');
  const confirm = page.getByRole('button', CONFIRM);
  await expect(confirm).toBeEnabled();
  await expect(confirm).not.toBeFocused();

  // Enter in the text field submits another parse at most; it never confirms.
  await box.fill('buy 5 MSFT at market');
  await box.press('Enter');
  await expect(page.getByTestId('draft-card')).toHaveCount(2);
  expect(api.calls.some((c) => c.endsWith('/confirm'))).toBe(false);

  // Tab until the first card's Confirm has focus, then activate it with the keyboard.
  const first = page.getByTestId('draft-card').first().getByRole('button', CONFIRM);
  for (let i = 0; i < 25 && !(await first.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('draft-badge').first()).toHaveText('Populated, verified');
  // The second draft is untouched: confirmation is per draft.
  await expect(page.getByTestId('draft-badge').nth(1)).toHaveText('Awaiting confirmation');
});

test('cancel: the draft disappears and nothing is handed off', async ({ page }) => {
  const api = await mockApi(page);
  await page.goto('/');
  await recordAndStop(page, 'Buy 100 shares of AAPL at 195.50');
  await page.getByRole('button', { name: 'Cancel draft' }).click();
  await expect(page.getByTestId('draft-card')).toHaveCount(0);
  expect(api.calls.some((c) => c.endsWith('/handoff'))).toBe(false);
});
