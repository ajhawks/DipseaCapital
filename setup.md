# CLAUDE.md — Silexx Voice Order Entry Assistant

This file provides context, conventions, and guardrails for Claude (and any AI coding assistant) working in this codebase. Read it fully before making any changes.

---

## Project Overview

**Silexx Voice Order Entry Assistant** is a voice-driven order entry application built for traders operating within the Cboe Silexx ecosystem. It converts spoken trade instructions into structured draft order tickets, reducing manual entry time and improving accuracy.

The system is built in two iterations:

**MVP (Iteration 1):** Orders follow a strict, predictable script (e.g., "[Side] [Qty] shares of [Symbol] at [Price/Market]"). Speech-to-text transcribes audio, a lightweight parser extracts fields, and the Silexx API is used to populate a draft order ticket. A browser-based UI lets traders record and review before any action is taken.

**NLP Iteration (Iteration 2):** Adds natural language understanding so traders can speak freely (e.g., "Let's go long 500 Apple at the market"). An NLP/LLM layer interprets intent, resolves ambiguity, and maps to order fields. This layer is additive — it does not change the underlying order safety model.

**Critical constraint:** The system is a draft-creation tool only. It never autonomously submits, routes, executes, modifies, or cancels orders. All order transmission is explicit and human-initiated.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React (TypeScript), Tailwind CSS |
| Voice capture | Web Speech API (MVP); Whisper or Deepgram (Iteration 2) |
| NLP/Parsing | Rule-based regex parser (MVP); OpenAI / local LLM (Iteration 2) |
| Backend | Node.js + Express (TypeScript) |
| Brokerage integration | Cboe Silexx REST/FIX API |
| Auth | JWT; API key management via environment variables |
| Testing | Jest (unit), Playwright (E2E) |
| Linting/Formatting | ESLint + Prettier |
| Environment management | dotenv |

---

## File Structure Notes

```
silexx-voice-assistant/
├── client/                      # React frontend
│   ├── src/
│   │   ├── components/          # UI components (RecordButton, OrderTicket, ReviewPanel)
│   │   ├── hooks/               # Custom hooks (useVoiceCapture, useOrderDraft)
│   │   ├── services/            # API calls to backend
│   │   ├── types/               # Shared TypeScript types (Order, OrderSide, etc.)
│   │   └── utils/               # Frontend helpers
│   └── public/
├── server/                      # Express backend
│   ├── src/
│   │   ├── routes/              # API route handlers
│   │   ├── services/
│   │   │   ├── parser/          # MVP script-based order parser
│   │   │   ├── nlp/             # Iteration 2 NLP layer (stub in MVP)
│   │   │   ├── silexx/          # Silexx API client and order builder
│   │   │   └── audit/           # Immutable audit log service
│   │   ├── middleware/          # Auth, error handling, request logging
│   │   ├── types/               # Server-side TypeScript types
│   │   └── utils/
│   └── tests/
├── shared/                      # Types and constants shared between client and server
├── docs/                        # Architecture diagrams, API contracts, compliance notes
├── .env.example                 # Environment variable template (never commit .env)
├── CLAUDE.md                    # This file
└── README.md
```

Key conventions:
- `client/` and `server/` are independent packages with their own `package.json`
- `shared/` types are the source of truth for cross-boundary data shapes (e.g., `OrderDraft`, `ParsedOrder`)
- Parser and NLP layers are intentionally separated so Iteration 2 can swap in without touching Silexx integration

---

## Coding Conventions

**TypeScript**
- Strict mode enabled everywhere (`"strict": true` in tsconfig)
- No `any` types without an explicit `// eslint-disable` comment explaining why
- Use `interface` for public API shapes; `type` for unions and utility types
- All async functions must handle errors explicitly — no silent `.catch(() => {})` suppressors

**Order Domain Types**
- `OrderDraft` is the canonical in-progress order: always includes a `status: 'draft'` field
- `ParsedOrder` is the raw output of the parser/NLP layer before validation
- `SubmittedOrder` only exists after explicit human confirmation — never create this type programmatically
- Use string enums for `OrderSide ('BUY' | 'SELL')`, `OrderType ('MARKET' | 'LIMIT' | 'STOP')`, `AssetClass ('EQUITY' | 'OPTION')`

**API & Backend**
- All route handlers are thin — business logic lives in `/services/`
- Every request that touches the Silexx API must be logged to the audit service before and after
- HTTP errors return `{ error: string; code: string }` — no raw stack traces in responses
- Rate limiting middleware is required on all voice/parse endpoints

**Frontend**
- Components are functional with hooks only — no class components
- Voice capture state lives in `useVoiceCapture`; order draft state lives in `useOrderDraft`
- The `ReviewPanel` component must always display the full parsed `OrderDraft` before any confirm button is enabled
- Never trigger Silexx API calls directly from a component — route through `services/`

**Testing**
- Every parser function must have unit tests covering: valid inputs, missing fields, ambiguous symbols, edge cases (e.g., "at market" vs. "at the market")
- E2E tests must include a "voice-to-draft-to-cancel" happy path and a "parser fails gracefully" path
- Mocks for the Silexx API live in `server/tests/__mocks__/silexx.ts`

---

## What Claude Should Always Do

- **Treat order safety as non-negotiable.** Every code change that touches order creation, confirmation, or transmission must be reviewed against the constraint that no order is ever sent without explicit human action.
- **Log everything near the Silexx API.** Calls to the Silexx client must always write to the audit log — add logging before modifying any `silexx/` service file.
- **Keep the parser and NLP layers decoupled.** The MVP parser in `services/parser/` must remain independently testable without any NLP dependency. Stub the NLP layer with a `NotImplemented` stub.
- **Validate symbol resolution explicitly.** When a spoken ticker or company name is resolved to a symbol, always surface the resolved symbol to the user in the `ReviewPanel` for confirmation before proceeding.
- **Use `shared/` types** as the source of truth when touching data that crosses the client–server boundary. Update `shared/` first, then propagate changes.
- **Write or update tests** when adding or modifying any parsing logic, order builder logic, or Silexx service methods.
- **Use `.env.example`** as the reference for any new environment variables — add the variable name and a description, never a real value.
- **Preserve the two-iteration boundary.** Code for MVP and Iteration 2 should be clearly separated (e.g., via feature flags or separate service directories), so MVP can ship cleanly without Iteration 2 code paths being active.

---

## What Claude Should Never Do

- **Never generate code that submits, routes, executes, modifies, or cancels an order autonomously.** Any function that transmits to the Silexx API must require a prior confirmed human action — this is a hard constraint, not a preference.
- **Never commit secrets or API keys.** Not in code, not in comments, not in test fixtures. Always use environment variables.
- **Never bypass the `ReviewPanel`.** Do not add shortcuts, keyboard handlers, or logic that allows an order to be "confirmed" without the full draft being displayed and acknowledged by the user.
- **Never swallow parsing errors silently.** If the parser cannot confidently extract all required fields (`side`, `quantity`, `symbol`, `orderType`), it must return a structured error — not a partial draft passed downstream.
- **Never add NLP or ML dependencies to the MVP parser.** The MVP parser must remain a simple, auditable, deterministic rule-based system.
- **Never use `any` in order-domain types** (`OrderDraft`, `ParsedOrder`, `SubmittedOrder`, `OrderSide`, `OrderType`). These types are compliance-adjacent and must be exact.
- **Never log raw audio or full transcripts to persistent storage** without explicit compliance review. Audit logs should capture parsed fields and metadata, not verbatim voice content by default.
- **Never make the confirm button the default action or auto-focused element** in the `ReviewPanel`. Confirmation must be a deliberate, non-accidental action.

---

## Running the Project Locally

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9
- Cboe Silexx API sandbox credentials (contact project lead)
- (Iteration 2 only) OpenAI API key or local model endpoint

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/your-org/silexx-voice-assistant.git
cd silexx-voice-assistant

# 2. Install dependencies for all packages
npm install --workspaces

# 3. Configure environment variables
cp .env.example .env
# Fill in SILEXX_API_KEY, SILEXX_API_URL, JWT_SECRET, and any other required vars

# 4. Start the backend (runs on :3001 by default)
cd server && npm run dev

# 5. In a separate terminal, start the frontend (runs on :3000 by default)
cd client && npm run dev
```

### Running Tests

```bash
# Unit tests (all packages)
npm test --workspaces

# E2E tests (requires both client and server running)
cd client && npx playwright test

# Parser unit tests only
cd server && npm test -- --testPathPattern=parser
```

### Useful Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Production build |
| `npm run lint` | Run ESLint across all files |
| `npm run format` | Run Prettier |
| `npm run typecheck` | Run tsc --noEmit |
| `npm test` | Run Jest unit tests |

### Environment Variables Reference

See `.env.example` for the full list. Key variables:

```
SILEXX_API_URL=          # Silexx sandbox or prod base URL
SILEXX_API_KEY=          # Your Silexx API key
JWT_SECRET=              # Secret for JWT signing
PORT=3001                # Backend port
ENABLE_NLP=false         # Set to true only for Iteration 2
```

---

## Architecture Notes for Claude

- The **parser** (`server/src/services/parser/`) is the most safety-critical code in the MVP. Changes here require the most scrutiny and test coverage.
- The **Silexx client** (`server/src/services/silexx/`) is a thin wrapper — do not add business logic here. It should only handle HTTP/FIX communication and error normalization.
- **Audit logging** is append-only by design. Do not add delete or update operations to the audit service under any circumstances.
- The `ReviewPanel` in the frontend is the human-in-the-loop gate. It must always show: resolved symbol, side, quantity, order type, price (if limit), and a clear warning that the order has not been submitted.
- When in doubt about whether a feature belongs in MVP or Iteration 2, it belongs in Iteration 2. The MVP goal is a working, auditable, safe draft-creation flow — not feature completeness.