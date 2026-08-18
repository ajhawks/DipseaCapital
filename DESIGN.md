# Silexx Voice Order Entry Assistant — Technical Design Document

**Version:** 1.0  
**Status:** Draft  
**Audience:** Engineering, Compliance, QA  

---

## 1. Problem Statement

Traders operating within the Cboe Silexx ecosystem manually key order tickets, which is slow, error-prone, and operationally risky during fast markets. This system converts spoken trade instructions into structured, reviewable draft order tickets, reducing input latency and typo-driven errors while maintaining an unbroken human-in-the-loop safety model.

**Hard constraint inherited from compliance:** The system is a **draft-creation tool only**. It has no authority to submit, route, execute, modify, or cancel orders. Every order transmission is an explicit, human-initiated act.

---

## 2. Scope & Iteration Boundary

| Capability | MVP (Iteration 1) | NLP (Iteration 2) |
|---|---|---|
| Voice capture | Web Speech API (browser) | Whisper / Deepgram |
| Parsing | Rule-based regex script | OpenAI / local LLM |
| Free-form speech | No | Yes |
| Ambiguity resolution | Fail → error | LLM-guided clarification |
| Silexx draft creation | Yes | Yes (unchanged) |
| Order submission | Never (by design) | Never (by design) |

Iteration 2 layers are **additive only** — the parser/NLP boundary is the seam. Iteration 2 must not alter the Silexx integration, the audit model, or the `ReviewPanel` gate.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (React)                       │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  │ RecordButton  │──▶│useVoiceCapture│──▶│  services/api   │  │
│  └──────────────┘   └──────────────┘   └────────┬────────┘  │
│                                                  │           │
│  ┌──────────────┐   ┌──────────────┐            │           │
│  │ ReviewPanel   │◀──│useOrderDraft │◀───────────┘           │
│  └──────────────┘   └──────────────┘                        │
└─────────────────────────────────────────────────────────────┘
                          HTTPS / REST
┌─────────────────────────────────────────────────────────────┐
│                     Node.js / Express                        │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  │  Auth + Rate  │   │  /parse      │   │  /draft         │  │
│  │  Middleware   │   │  route       │   │  route          │  │
│  └──────────────┘   └──────┬───────┘   └────────┬────────┘  │
│                             │                    │           │
│               ┌─────────────▼──────┐   ┌─────────▼───────┐  │
│               │  Parser Service    │   │  Silexx Client  │  │
│               │  (MVP: regex)      │   │  (thin wrapper) │  │
│               │  (Iter2: NLP stub) │   └─────────┬───────┘  │
│               └─────────────┬──────┘             │           │
│                             │           ┌─────────▼───────┐  │
│                    ┌────────▼───────┐   │  Audit Service  │  │
│                    │  Validator     │   │  (append-only)  │  │
│                    └────────────────┘   └─────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                          REST / FIX
                    ┌──────────────────┐
                    │  Cboe Silexx API  │
                    └──────────────────┘
```

### 3.1 Data Flow (MVP Happy Path)

1. Trader presses **Record** → `useVoiceCapture` activates Web Speech API.
2. Browser streams transcript text to `POST /api/parse` with JWT.
3. **Parser Service** applies ordered regex rules → emits `ParsedOrder` or structured error.
4. **Validator** checks all required fields present; resolves symbol if needed.
5. Response carries `OrderDraft` (status: `'draft'`) back to client.
6. `useOrderDraft` stores draft; `ReviewPanel` renders full draft — confirm button disabled until user reads all fields.
7. Trader clicks **Confirm** → `POST /api/draft` sends `OrderDraft` to Silexx client.
8. Silexx client writes to audit log, calls Silexx API, writes result to audit log.
9. Silexx returns a draft ticket ID; frontend displays success. **No order is submitted.**

---

## 4. Data Models

All types live in `shared/` and are the source of truth for both client and server.

### 4.1 Core Types

```typescript
// shared/types/order.ts

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP';
export type AssetClass = 'EQUITY' | 'OPTION';
export type DraftStatus = 'draft';

/** Raw output of the parser/NLP layer before validation. */
export interface ParsedOrder {
  side?: OrderSide;
  quantity?: number;
  rawSymbol?: string;          // as spoken, before resolution
  resolvedSymbol?: string;     // after symbol lookup
  orderType?: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  assetClass?: AssetClass;
  confidence?: number;         // Iteration 2: LLM confidence score
}

/** Validated, in-progress order ready for human review. */
export interface OrderDraft {
  id: string;                  // client-generated UUID
  status: DraftStatus;
  side: OrderSide;
  quantity: number;
  symbol: string;              // always the resolved symbol
  rawSymbol: string;           // what the trader spoke
  orderType: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  assetClass: AssetClass;
  createdAt: string;           // ISO 8601
  transcriptFragment?: string; // the spoken phrase (not stored persistently)
}

/** Only exists after explicit confirmed human action — never instantiated by code. */
export interface SubmittedOrder extends OrderDraft {
  silexxTicketId: string;
  submittedAt: string;
  submittedByUserId: string;
}
```

### 4.2 API Envelope Types

```typescript
// shared/types/api.ts

export interface ParseRequest {
  transcript: string;
}

export interface ParseResponse {
  draft: OrderDraft;
}

export interface ParseErrorResponse {
  error: string;
  code: 'MISSING_FIELDS' | 'AMBIGUOUS_SYMBOL' | 'PARSE_FAILED' | 'RATE_LIMITED';
  missingFields?: (keyof OrderDraft)[];
}

export interface DraftCreateRequest {
  draft: OrderDraft;
  userConfirmedAt: string;     // ISO 8601 timestamp of the explicit confirm click
}

export interface DraftCreateResponse {
  silexxTicketId: string;
  status: 'created';
}
```

### 4.3 Audit Log Entry

```typescript
// server/src/services/audit/types.ts

export interface AuditEntry {
  id: string;
  timestamp: string;
  userId: string;
  action: 'PARSE_REQUEST' | 'PARSE_SUCCESS' | 'PARSE_FAILURE'
        | 'DRAFT_SUBMITTED' | 'SILEXX_API_CALLED' | 'SILEXX_API_RESPONSE';
  orderId?: string;
  silexxTicketId?: string;
  parsedFields?: Omit<OrderDraft, 'transcriptFragment'>; // never log raw audio
  errorCode?: string;
  metadata?: Record<string, string | number | boolean>;
}
```

---

## 5. API Contract

### 5.1 `POST /api/parse`

Converts a transcript to a validated `OrderDraft`.

**Auth:** Bearer JWT required.  
**Rate limit:** 10 requests / minute per user (configurable).

**Request body:** `ParseRequest`  
**Success response (200):** `ParseResponse`  
**Error response (400 / 422):** `ParseErrorResponse`

**Behavior:**
- The parser must emit a structured `ParseErrorResponse` if any of `side`, `quantity`, `symbol`, or `orderType` cannot be confidently extracted.
- A partial draft is never returned from this endpoint.
- `resolvedSymbol` is always included in the success response; the client must surface it in `ReviewPanel`.

---

### 5.2 `POST /api/draft`

Creates a draft order ticket in the Silexx system.

**Auth:** Bearer JWT required.  
**Rate limit:** 5 requests / minute per user.

**Request body:** `DraftCreateRequest`  
**Success response (200):** `DraftCreateResponse`  
**Error responses:**
- `400` — invalid draft shape
- `409` — duplicate draft ID
- `502` — Silexx API unreachable

**Behavior:**
- Audit log entry written **before** calling Silexx API.
- Audit log entry written **after** receiving Silexx response (success or failure).
- This endpoint never submits an order — it creates a draft ticket in the Silexx UI for trader review.

---

### 5.3 `GET /api/health`

Returns server status. No auth required.

---

## 6. Parser Design (MVP)

### 6.1 Grammar

MVP transcripts conform to:

```
<side> <quantity> shares of <symbol> [at <price>|at the market|at market]
```

Examples:
- `"Buy 100 shares of AAPL at 195.50"`
- `"Sell 500 shares of MSFT at the market"`
- `"BUY 200 shares of TSLA at market"`

### 6.2 Rule Pipeline

Rules are applied in order; first match wins per field.

```
1. SIDE_RULE        → /^(buy|sell)\b/i
2. QUANTITY_RULE    → /\b(\d[\d,]*)\s+shares?\b/i
3. SYMBOL_RULE      → /\bof\s+([A-Z]{1,5})\b/i
4. ORDER_TYPE_RULE  → /\bat\s+(the\s+)?market\b/i → MARKET
                      /\bat\s+([\d.]+)\b/i         → LIMIT with price
```

### 6.3 Error Handling

If any required field rule produces no match:

```typescript
throw new ParseError({
  code: 'MISSING_FIELDS',
  missingFields: ['quantity', 'symbol'],  // whichever are absent
});
```

Errors are never swallowed. They propagate to the route handler, which returns a `ParseErrorResponse` to the client.

### 6.4 Iteration 2 Seam

```typescript
// server/src/services/nlp/index.ts (MVP stub)

export async function interpretWithNLP(_transcript: string): Promise<ParsedOrder> {
  throw new Error('NLP layer not implemented. Set ENABLE_NLP=true for Iteration 2.');
}
```

The parser route checks `process.env.ENABLE_NLP`:
- `false` (default) → regex parser
- `true` → NLP service (Iteration 2)

No other code paths change.

---

## 7. Frontend Component Design

### 7.1 Component Hierarchy

```
<App>
  <Header />
  <VoiceOrderPanel>
    <RecordButton />           ← controls useVoiceCapture
    <TranscriptDisplay />      ← shows live transcript text
    <ReviewPanel />            ← shows full OrderDraft; owns confirm button
      <OrderSummaryRow />      ← side, qty, symbol, type, price
      <SymbolConfirmBanner />  ← highlights rawSymbol vs resolvedSymbol
      <WarningBanner />        ← "This order has NOT been submitted"
      <ConfirmButton />        ← disabled until all fields visible
      <CancelButton />
    </ReviewPanel>
  </VoiceOrderPanel>
</App>
```

### 7.2 Key Hooks

**`useVoiceCapture`**

| State | Type | Description |
|---|---|---|
| `isRecording` | `boolean` | Mic active |
| `transcript` | `string` | Current raw transcript |
| `error` | `string \| null` | Browser speech error |

Methods: `startRecording()`, `stopRecording()`, `reset()`

**`useOrderDraft`**

| State | Type | Description |
|---|---|---|
| `draft` | `OrderDraft \| null` | Current parsed draft |
| `isLoading` | `boolean` | Parse request in flight |
| `parseError` | `ParseErrorResponse \| null` | Last parse error |
| `draftStatus` | `'idle' \| 'reviewing' \| 'submitted'` | UI state machine |

Methods: `submitTranscript(transcript)`, `confirmDraft()`, `cancelDraft()`

### 7.3 ReviewPanel Invariants

- `ConfirmButton` is **never** the default-focused element and must not respond to `Enter` from transcript field.
- `ConfirmButton` is disabled until `draft !== null` and all required fields are rendered.
- `SymbolConfirmBanner` is always rendered when `rawSymbol !== resolvedSymbol`.
- `WarningBanner` with text "This order has NOT been submitted to the market" is always visible while `draft.status === 'draft'`.

---

## 8. Security & Auth Model

### 8.1 JWT

- All `/api/*` endpoints (except `/api/health`) require `Authorization: Bearer <token>`.
- Tokens are signed with `JWT_SECRET` (HS256); expiry 8 hours.
- Middleware short-circuits with `401` on invalid or expired tokens.

### 8.2 API Key Management

- `SILEXX_API_KEY` is read exclusively from environment variables via `dotenv`.
- Never passed through the frontend; never logged.
- Rotation: update `.env` and restart — no code change required.

### 8.3 Rate Limiting

| Endpoint | Limit |
|---|---|
| `POST /api/parse` | 10 req/min per user |
| `POST /api/draft` | 5 req/min per user |

Responses: `429 Too Many Requests` with `ParseErrorResponse { code: 'RATE_LIMITED' }`.

### 8.4 Secrets & Logging Policy

- Audit logs capture parsed fields and metadata only. Raw transcripts are **never** stored persistently without compliance sign-off.
- No API keys, JWTs, or secrets appear in logs, errors, or HTTP responses.
- Stack traces are never returned in HTTP responses (absorbed by error middleware).

---

## 9. Audit Service

The audit service is append-only. No delete or update operations exist.

```typescript
// server/src/services/audit/auditService.ts (interface)

interface AuditService {
  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<void>;
}
```

**MVP implementation:** writes to a local NDJSON file or in-memory store.  
**Production path:** replace implementation with a database-backed or SIEM-compatible sink — the interface does not change.

Every call to `silexx/` service methods must call `auditService.log()` before and after. This is enforced by code review convention and verified by tests that assert audit entries for every Silexx call.

---

## 10. Testing Strategy

### 10.1 Parser Unit Tests (Jest)

Required cases per parser function:

| Category | Examples |
|---|---|
| Valid, canonical | `"Buy 100 shares of AAPL at 195.50"` |
| Market order variants | `"at market"`, `"at the market"`, `"AT MARKET"` |
| Missing side | `"100 shares of AAPL at market"` → `MISSING_FIELDS: ['side']` |
| Missing quantity | `"Buy shares of AAPL at 50"` → `MISSING_FIELDS: ['quantity']` |
| Ambiguous symbol | `"Buy 100 shares of Apple at market"` → `AMBIGUOUS_SYMBOL` |
| Extra words | `"Let me buy 100 shares of AAPL at 50"` — should fail MVP parser cleanly |
| Numeric edge cases | `"Buy 1,000 shares"`, `"Buy 1000000 shares"` |

### 10.2 E2E Tests (Playwright)

**Happy path:** Record → parse → review → confirm → draft ticket created → verify Silexx mock called.  
**Graceful failure:** Record → parse fails → error displayed → record again.  
**ReviewPanel gate:** Programmatically attempt to confirm without viewing full draft → confirm button is disabled.  
**Cancel path:** Record → parse → review → cancel → draft discarded → no Silexx call.

### 10.3 Silexx API Mock

```
server/tests/__mocks__/silexx.ts
```

Provides:
- `createDraft(draft)` → returns `{ silexxTicketId: 'MOCK-TICKET-001' }`
- Captures all calls for assertion
- Simulates 502 failure on demand

---

## 11. Error Handling Matrix

| Scenario | Parser | Route | Client |
|---|---|---|---|
| Missing required field | Throws `ParseError` | Returns `422 ParseErrorResponse` | `ReviewPanel` shows error, prompts re-record |
| Silexx API timeout | N/A | Returns `502` | Toast: "Silexx unavailable, try again" |
| Speech API unavailable | N/A | N/A | `RecordButton` disabled with inline message |
| JWT expired | N/A | Returns `401` | Redirect to login |
| Rate limit exceeded | N/A | Returns `429` | Toast with retry-after time |
| Symbol unresolvable | Throws `ParseError` code `AMBIGUOUS_SYMBOL` | Returns `422` | Show raw spoken symbol, prompt manual entry |

---

## 12. Environment Variables

See `.env.example` for full reference. Key variables:

| Variable | Required | Description |
|---|---|---|
| `SILEXX_API_URL` | Yes | Silexx sandbox or prod base URL |
| `SILEXX_API_KEY` | Yes | Silexx API key (never logged) |
| `JWT_SECRET` | Yes | HS256 signing secret |
| `PORT` | No (default 3001) | Backend port |
| `ENABLE_NLP` | No (default `false`) | Set `true` only for Iteration 2 |

---

## 13. Implementation Roadmap (Concurrent Agent Task Plan)

Tasks are organized into sequential **waves**. Within each wave, all lettered tasks (`a`, `b`, `c`, …) are independent and can be assigned to separate agents running in parallel. A wave must complete before the next begins.

**Dependency key:** `→` means "requires output of"

---

### Wave 1 — Foundation *(sequential, all other waves depend on this)*

**1. Monorepo scaffold + shared types**
- Initialize `package.json` for root, `client/`, `server/`, `shared/` workspaces
- Configure `tsconfig.json` (strict mode) for each package
- Configure ESLint + Prettier across all packages
- Create directory skeletons: `client/src/{components,hooks,services,types,utils}`, `server/src/{routes,services/{parser,nlp,silexx,audit},middleware,types,utils}`, `server/tests/__mocks__/`
- Define all types in `shared/types/`: `OrderSide`, `OrderType`, `AssetClass`, `DraftStatus`, `ParsedOrder`, `OrderDraft`, `SubmittedOrder`, `ParseRequest`, `ParseResponse`, `ParseErrorResponse`, `DraftCreateRequest`, `DraftCreateResponse`
- Write `.env.example` with all variables from §12

> **No other wave starts until Wave 1 is merged.** Shared types are the contract every other agent codes against.

---

### Wave 2 — Server & Client Scaffolds *(parallel)*

**2a. Server: Express app + middleware layer**
- `server/src/index.ts`: Express app, port binding, graceful shutdown
- Auth middleware: JWT verification (`Authorization: Bearer`), `401` on failure
- Rate-limiting middleware: 10 req/min on `/api/parse`, 5 req/min on `/api/draft`; returns `429` with `ParseErrorResponse { code: 'RATE_LIMITED' }`
- Error-handling middleware: catches thrown errors, returns `{ error, code }`, no stack traces in responses
- Request logger middleware (structured JSON, no secrets)
- Stub route registrations: `POST /api/parse`, `POST /api/draft`, `GET /api/health`
- *Dependencies:* Wave 1

**2b. Client: React app scaffold + API service layer**
- Vite + React + TypeScript project under `client/`
- Tailwind CSS configuration
- `client/src/services/api.ts`: typed `fetchParse(transcript)` and `fetchCreateDraft(draft)` functions wrapping `fetch` to backend, using shared API types
- `client/src/types/` re-exports from `shared/`
- Placeholder `<App>` renders `<VoiceOrderPanel>` skeleton
- *Dependencies:* Wave 1

---

### Wave 3 — Core Server Services + Core Client Hooks *(parallel)*

**3a. Server: Parser service**
- `server/src/services/parser/index.ts`: ordered regex rule pipeline (SIDE → QUANTITY → SYMBOL → ORDER_TYPE)
- `ParseError` class with `code` and `missingFields`
- All required fields missing → throws `ParseError`; partial drafts never returned
- Exports `parseTranscript(transcript: string): ParsedOrder`
- *Dependencies:* Wave 1

**3b. Server: Audit service**
- `server/src/services/audit/auditService.ts`: append-only NDJSON writer
- `AuditEntry` type as specified in §4.3
- `log(entry)` is the only public method — no delete, no update
- *Dependencies:* Wave 1

**3c. Client: `useVoiceCapture` hook**
- State: `isRecording`, `transcript`, `error`
- Methods: `startRecording()`, `stopRecording()`, `reset()`
- Wraps Web Speech API; surfaces browser errors as typed state (never throws)
- *Dependencies:* Wave 1

**3d. Client: `useOrderDraft` hook**
- State: `draft`, `isLoading`, `parseError`, `draftStatus` (`'idle' | 'reviewing' | 'submitted'`)
- Methods: `submitTranscript(transcript)` → calls `services/api.fetchParse`, `confirmDraft()` → calls `services/api.fetchCreateDraft`, `cancelDraft()`
- Never calls Silexx directly; never creates a `SubmittedOrder`
- *Dependencies:* Wave 1, Wave 2b

---

### Wave 4 — Routes, Silexx Client, UI Components *(parallel)*

**4a. Server: Silexx API client**
- `server/src/services/silexx/silexxClient.ts`: thin HTTP wrapper around Silexx REST API
- `createDraft(draft: OrderDraft): Promise<{ silexxTicketId: string }>` — only public method for MVP
- Normalizes Silexx HTTP errors to typed `SilexxError`; no business logic here
- Calls `auditService.log()` before and after every API call — no exceptions
- *Dependencies:* Wave 1, 3b

**4b. Server: `/api/parse` route handler**
- `server/src/routes/parse.ts`: validates `ParseRequest` body → calls parser → calls validator → calls audit → returns `ParseResponse` or `ParseErrorResponse`
- Checks `ENABLE_NLP` env flag: `false` → parser, `true` → NLP stub (see 4c)
- Writes `PARSE_REQUEST` + (`PARSE_SUCCESS` | `PARSE_FAILURE`) audit entries
- *Dependencies:* Wave 1, 2a, 3a, 3b

**4c. Server: NLP stub + feature flag gate**
- `server/src/services/nlp/index.ts`: `interpretWithNLP()` throws `NotImplementedError` with clear message
- `ENABLE_NLP=false` guard in parse route prevents stub from being reached in MVP
- *Dependencies:* Wave 1, 3a

**4d. Client: `RecordButton` + `TranscriptDisplay` components**
- `<RecordButton>`: start/stop toggle; disabled when `isLoading`; no keyboard shortcut that could conflict with `ReviewPanel`
- `<TranscriptDisplay>`: renders live `transcript` string; readonly
- *Dependencies:* Wave 1, 3c

**4e. Client: `ReviewPanel` component**
- `<OrderSummaryRow>`: renders `side`, `quantity`, `symbol`, `orderType`, `limitPrice` from `OrderDraft`
- `<SymbolConfirmBanner>`: visible when `rawSymbol !== resolvedSymbol`; shows both values
- `<WarningBanner>`: always visible while `draft.status === 'draft'`; text "This order has NOT been submitted to the market"
- `<ConfirmButton>`: disabled until `draft !== null` and all required fields rendered; never auto-focused; does not respond to Enter from transcript field
- `<CancelButton>`: always enabled when draft present
- *Dependencies:* Wave 1, 3d

---

### Wave 5 — Final Server Route + UI Assembly *(parallel)*

**5a. Server: `/api/draft` route handler**
- `server/src/routes/draft.ts`: validates `DraftCreateRequest` → calls Silexx client → returns `DraftCreateResponse`
- Rejects if `userConfirmedAt` is missing (human confirmation timestamp is required)
- Handles `SilexxError` → `502`; duplicate ID → `409`
- *Dependencies:* Wave 1, 2a, 3b, 4a

**5b. Client: `VoiceOrderPanel` assembly**
- Composes `<RecordButton>`, `<TranscriptDisplay>`, `<ReviewPanel>` into the main panel
- Wires `useVoiceCapture` → `useOrderDraft.submitTranscript` on stop
- Handles `parseError` display (inline error with re-record prompt)
- *Dependencies:* Wave 1, 4d, 4e

---

### Wave 6 — Tests *(parallel)*

**6a. Parser unit tests (Jest)**
- Cover all cases from §10.1: valid inputs, market variants, missing each required field, ambiguous symbol, extra words, numeric edge cases
- Must reach 100% branch coverage of `server/src/services/parser/`
- *Dependencies:* Wave 3a

**6b. Silexx mock + audit + service tests**
- `server/tests/__mocks__/silexx.ts`: captures calls, returns `MOCK-TICKET-001`, configurable 502 failure
- Unit tests for `auditService`: verifies append-only writes, correct entry shape
- Unit tests for Silexx client: verifies audit entries fire before and after API call
- *Dependencies:* Wave 4a, 3b

**6c. E2E tests (Playwright)**
- Happy path: record → parse → review → confirm → draft ticket created
- Graceful failure: parse fails → error shown → re-record
- `ReviewPanel` gate: confirm button disabled before full draft visible
- Cancel path: record → parse → cancel → no Silexx call
- *Dependencies:* Wave 5a, 5b

---

### Wave Summary

```
Wave 1 ──────────────────────────────────────────────── (monorepo + shared types)
         ↓
Wave 2a ── Wave 2b                                       (server scaffold | client scaffold)
         ↓
Wave 3a ── Wave 3b ── Wave 3c ── Wave 3d                 (parser | audit | voice hook | draft hook)
         ↓
Wave 4a ── Wave 4b ── Wave 4c ── Wave 4d ── Wave 4e      (silexx | parse route | nlp stub | RecordButton | ReviewPanel)
         ↓
Wave 5a ── Wave 5b                                        (draft route | UI assembly)
         ↓
Wave 6a ── Wave 6b ── Wave 6c                             (parser tests | mock+service tests | E2E)
```

**Estimated parallel agent budget per wave:** 1 / 2 / 4 / 5 / 2 / 3

---

## 14. Open Questions & Decisions Deferred to Iteration 2

| Question | Deferred Reason |
|---|---|
| Symbol resolution service (fuzzy company name → ticker) | Needed for free-form speech; not in MVP grammar |
| LLM provider selection (OpenAI vs. local Llama) | Cost/latency trade-off requires pilot data |
| Whisper vs. Deepgram for server-side STT | Latency and accuracy benchmarks needed |
| Persistent audit log storage (DB schema, SIEM target) | Compliance team review in progress |
| Multi-trader session isolation | Single-trader scope for MVP |
| Confidence threshold tuning for LLM parser | Requires labeled sample data from traders |

---

## 15. Compliance Notes

- This document and the system it describes are scoped to **draft creation only**. Integration with any order execution pathway requires separate compliance review.
- Audio data retention policy is pending compliance sign-off. Default posture: do not persist raw audio or verbatim transcripts.
- Any change to audit log schema, retention, or write path must be reviewed by compliance before merging.
- The `SubmittedOrder` type must never be instantiated by application code — it exists solely as a TypeScript contract for data received from Silexx after human-initiated submission.
