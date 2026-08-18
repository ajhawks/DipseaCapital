import { test, expect, type Page } from '@playwright/test';

// ── shared fixtures ───────────────────────────────────────────────────────────

const MOCK_DRAFT = {
  id: 'draft-e2e-001',
  status: 'draft',
  side: 'BUY',
  quantity: 100,
  symbol: 'AAPL',
  rawSymbol: 'AAPL',
  orderType: 'LIMIT',
  limitPrice: 195.5,
  assetClass: 'EQUITY',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const PARSE_OK = { draft: MOCK_DRAFT };
const DRAFT_OK = { silexxTicketId: 'SILEXX-E2E-001', status: 'created' };
const PARSE_ERR = {
  error: 'Could not extract quantity.',
  code: 'MISSING_FIELDS',
  missingFields: ['quantity'],
};

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

  await page.goto('/');
});

// ── tests ─────────────────────────────────────────────────────────────────────

test('happy path: record → parse → review → confirm → draft ticket created', async ({ page }) => {
  await page.route('**/api/parse', (route) => route.fulfill({ json: PARSE_OK }));
  await page.route('**/api/draft', (route) => route.fulfill({ json: DRAFT_OK }));

  await recordAndStop(page, 'Buy 100 shares of AAPL at 195.50');

  // ReviewPanel renders with all required elements. Exact-match locators scoped
  // to the panel so the live transcript ("Buy 100 shares of AAPL…") never
  // collides under strict mode.
  await expect(page.getByText('This order has NOT been submitted to the market')).toBeVisible();
  const review = page.getByTestId('review-panel');
  await expect(review.getByText('BUY', { exact: true })).toBeVisible();
  await expect(review.getByText('AAPL', { exact: true })).toBeVisible();
  await expect(review.getByText('LIMIT', { exact: true })).toBeVisible();

  // Confirm button is enabled once the full draft is visible
  const confirmBtn = page.getByRole('button', { name: 'Confirm Draft' });
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();

  // Success screen confirms draft was sent to Silexx (not submitted to market)
  await expect(page.getByText('Draft ticket created in Silexx')).toBeVisible();
  await expect(page.getByText('Open Silexx to review the draft and submit when ready.')).toBeVisible();
  await expect(page.getByText(`Ticket ${DRAFT_OK.silexxTicketId}`)).toBeVisible();
});

test('graceful failure: parse error → error shown → re-record available', async ({ page }) => {
  await page.route('**/api/parse', (route) =>
    route.fulfill({ status: 422, json: PARSE_ERR }),
  );

  await recordAndStop(page, 'shares of something unclear');

  // Error panel
  await expect(page.getByText('Could not parse order')).toBeVisible();
  await expect(page.getByText('Could not extract quantity.')).toBeVisible();
  await expect(page.getByText('Missing: quantity')).toBeVisible();

  // Re-record prompt from VoiceOrderPanel
  await expect(
    page.getByText('Record again with a different phrase to retry.'),
  ).toBeVisible();

  // Record button re-enabled for retry (isLoading is false after failure)
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled();
});

test('ReviewPanel gate: confirm button absent before draft, enabled only after draft loads', async ({ page }) => {
  // Gate 1: no recording yet → confirm button does not exist
  await expect(page.getByRole('button', { name: 'Confirm Draft' })).not.toBeVisible();

  // Introduce a 200 ms delay so we can assert the loading state.
  await page.route('**/api/parse', async (route) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ json: PARSE_OK });
  });

  await page.click('button[aria-label="Start recording"]');
  await page.evaluate((text: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setSpeechTranscript(text);
  }, 'Buy 100 shares of AAPL at 195.50');
  await page.click('button[aria-label="Stop recording"]');

  // Gate 2: while parse is in-flight (draft still null), confirm button is absent
  await expect(page.getByRole('button', { name: 'Confirm Draft' })).not.toBeVisible();

  // Gate 3: once parse resolves and draft is set, confirm button appears and is enabled
  await expect(page.getByRole('button', { name: 'Confirm Draft' })).toBeEnabled({
    timeout: 5_000,
  });

  // Structural gate: button cannot be reached via Tab or triggered by Enter from
  // another field (tabIndex=-1, type="button", explicit onKeyDown guard).
  const confirmBtn = page.getByRole('button', { name: 'Confirm Draft' });
  await expect(confirmBtn).toHaveAttribute('tabindex', '-1');
  await expect(confirmBtn).toHaveAttribute('type', 'button');
});

test('cancel path: record → parse → cancel → no /api/draft call made', async ({ page }) => {
  await page.route('**/api/parse', (route) => route.fulfill({ json: PARSE_OK }));

  let draftCalled = false;
  await page.route('**/api/draft', (route) => {
    draftCalled = true;
    return route.fulfill({ json: DRAFT_OK });
  });

  await recordAndStop(page, 'Buy 100 shares of AAPL at 195.50');

  // Wait for ReviewPanel so we know the parse resolved
  await expect(page.getByText('This order has NOT been submitted to the market')).toBeVisible();

  // Cancel the draft
  await page.getByRole('button', { name: 'Cancel' }).click();

  // ReviewPanel dismissed — draft cleared from state
  await expect(
    page.getByText('This order has NOT been submitted to the market'),
  ).not.toBeVisible();

  // /api/draft was never called
  expect(draftCalled).toBe(false);
});
