# Implementation Plan

How to get from the current codebase to a reliable first release of the Voice
Order Entry Assistant. The spec is `DESIGN_DOC.md`; its safety invariants are
release-blocking and are not repeated here, only referenced as **INV-n**. These
two files are the only planning documents; ADRs live in `docs/adr/`.

The earlier M1 work (eval harness, Wilson CIs, McNemar compare, dataset v2) is
done and reused as-is; its baselines are in §9.

**Working rules:**
- **Evidence or it isn't done.** A task is ✅ only with the evidence its *Accept*
  names (a test run, an eval result file, a `compare.mts` output), logged in §9.
- **Missed targets are reported, not hidden.** Log the actual number; the task
  stays open or is explicitly re-scoped here.
- **Parser changes include a before/after.** Any task touching `services/nlp`,
  `services/parser` or `services/symbols` runs the dev eval before and after;
  `compare.mts` must show no significant regression (McNemar p < 0.05) in
  categories the task wasn't meant to change. Tune on `dev`; run `heldout` only
  at phase exits.
- **Commits are prefixed with the task ID** (e.g. `[S1.2]`).
- **Every task ends with a plain-language explanation** of what was built, why,
  and the concept behind it.
- **Scope changes go in this file first**, before any code changes.

**Revision 2 (2026-10-28):** the MVP is split into **Core** (safe, usable, pilot
eligible) and **V1 remainder**. The pilot now depends explicitly on the real Silexx
adapter. Added the cross-cutting rules **R-ATOMIC** (draft state + audit in one
transaction) and **R-VERIFY** (what counts as a successful handoff). Statuses were
re-checked against the repository (§7). Task IDs are unchanged; S5.2 moved into Core.

---

## 1. Assessment

### Working and worth keeping

| Area | State |
|---|---|
| Monorepo (client / server / shared), TS strict, ESLint | Builds; 62 server unit tests and 4 Playwright e2e tests pass |
| Eval harness | 463 cases, stratified dev/heldout (≥10 per category), Wilson CIs, McNemar `compare.mts`, git SHA + source hash per run. Strongest part of the repo |
| LLM layer (`services/nlp`) | Provider-agnostic (OpenAI-compatible `fetch`), local Ollama, confidence floor, refuses on missing fields. Dev 94.5%, 0/97 hallucinations, ambiguity 14/14 |
| Symbol resolution (`services/symbols`) | Deterministic, ambiguity → candidates → clarify UI. Seed table of 26 tickers |
| Review UI | Draft-only warning, symbol-resolution banner, plain-English sentence, confirm never auto-focused, ambiguity picker |
| Silexx client + stub | Audits before/after each call; stub enables end-to-end runs |
| Error handling / logging | No stack traces in responses; secret headers redacted |

### Gaps that break a safety invariant (must fix before any real use)

1. **The server trusts the client's draft (INV-2, INV-3, INV-9).** `POST /api/draft`
   accepts any well-shaped draft plus a client-made timestamp. Drafts aren't stored
   server-side, so there is no versioned confirmation and no server re-validation.
   A crafted request can hand off an order that was never parsed or reviewed.
2. **Uncertain handoffs are reported as plain failures (INV-7, INV-8).** A network
   error after the request is sent returns `502 "try again"`. There is no timeout
   (`silexxClient.ts` has no abort), no "outcome uncertain" state, no idempotency
   key, and no reconciliation.
3. **Handoff success is never verified (INV-1, INV-7).** Any 2xx response is treated
   as success, and `body.silexxTicketId` is trusted without checking it exists. Nothing
   confirms the ticket in Silexx matches what the trader confirmed, or that it is
   still an unsubmitted draft.
4. **Draft state and audit aren't atomic.** Audit writes are separate `appendFile`
   calls; a crash or write failure between them and the action leaves the log and
   reality out of step.
5. **Web Speech API sends audio to Google (INV-10, INV-11).** Chrome's
   `SpeechRecognition` is a cloud service. It is the only voice path today.
6. **Silexx capability is unverified.** `POST {SILEXX_API_URL}/orders/draft` is an
   invented endpoint. The whole product depends on a "populate draft, don't
   submit" API existing.
7. **Audit log is a plain NDJSON file**: not hash-chained, not verifiable, missing
   most required event types (edits, warnings, clarifications, cancellations,
   settings, versions, exports).
8. **Confirm button is unreachable by keyboard** (`tabIndex={-1}` plus Enter
   blocked in `ReviewPanel.tsx`). This fails the keyboard-only requirement.
   Not auto-focusing it is right; removing it from tab order is not.
9. **Auth is a pasted JWT in localStorage**, with no SSO and no fail-closed
   session handling.

### Incomplete against the V1 scope

- Order model: no `STOP_LIMIT` (stop-limit), time in force, account, open/close, or
  options fields. One draft per utterance only.
- No field editing, no warnings or acknowledgements, no duplicate detection, no
  manual text entry, no history, no settings, no supervisor role.
- Two parse paths, chosen by `ENABLE_NLP`. The regex path is rigid and skips symbol
  resolution. There's no deterministic normalization, fast path, side lexicon, or
  LLM/lexicon disagreement check.
- Eval measures `interpretWithNLP` only, not the request pipeline.
  **`DESIGN_DOC.md` says the dataset contains `multi_order`, `options` and
  `prompt_injection`. It doesn't; those categories don't exist yet.**
- Latency: LLM-path p95 is **3.96 s** against a 1.5 s target. Benchmark hardware
  is undocumented.
- No CI, no OpenTelemetry, no deployment config, no backups.

### Unnecessary or conflicting (remove or rewrite)

- ~~`setup.md`, `DESIGN.md`, `docs/ROADMAP.md`, `docs/PLAN.md`~~: removed in S0.1.
  They recommended hosted LLM/STT, an Iteration 1/2 split, or "speech never leaves
  the machine", all of which conflict with the spec. The right principle is
  **self-hosted on company-controlled infrastructure**.
- `SubmittedOrder` type: the app never receives one, and the name suggests
  submission. Delete it.
- `ENABLE_NLP` flag and the Iteration 1/2 split. Replace with one pipeline where the
  regex parser is the deterministic fast path.
- Out of scope for V1: Prometheus as a separate stack (OTel covers it), k6 load
  testing, streaming STT, spoken TTS readback, automatic model activation. See §3.

---

## 2. Decisions needed (owner: you / the team)

Ordered by how much work they block. Code tasks that depend on them say so.

| ID | Decision | Blocks | Recommendation |
|---|---|---|---|
| **D1** | Does Silexx have an official API/SDK that populates a draft ticket **without submitting**? Does it support idempotency keys, ticket lookup by ID or client key, and reading back ticket fields and status? | S5.2 → **pilot** and release | Ask Cboe now; it's the critical path. **If no such API exists, the product changes** (e.g. the app shows a structured ticket the trader keys in by hand). Decide that before Phase 3. The lookup/read-back answer sets how strong R-VERIFY can be |
| **D2** | Speech recognition: self-hosted Whisper, or explicitly approve Web Speech (Google) for a pilot? | S3.6 (Core voice) | Self-hosted whisper.cpp. Until then, Core runs on manual text entry and Web Speech stays dev-only |
| **D3a** | Storage engine | S1.2, S1.4, S1.5 (R-ATOMIC needs transactions) | **Decide now: PostgreSQL** (already proposed; one store for drafts, audit, settings, history). Runs in Docker locally regardless of hosting |
| D3b | Hosting provider | S4.6 | Company infra, Docker images. Needed before the pilot, not before Phase 1 code |
| **D4** | SSO provider (OIDC/SAML) and group → role mapping | S4.1, S4.2 | OIDC authorization-code flow, server session in an httpOnly cookie |
| **D5** | Silexx-required fields: TIF values, account selection, short sale vs. sell, buy-to-cover, options open/close | S1.1 final schema, S5.2 | Model them now as optional typed fields; mark required after D1 |
| **D6** | Transcript retention in audit (store text? hash only? N days?) | S1.5 schema | Store the transcript in the audit record with a separate retention class; never store audio |
| **D7** | Sanity-check thresholds and which settings users may change | S1.3 config values | Ship the mechanism with **no default limits** (spec: don't invent limits); an admin sets values |
| **D8** | Options: how to verify a contract exists (expiry/strike) without a market-data feed | S2.6 (V1) | Without a chain source, only accept fully specified contracts (explicit date + strike + C/P) and warn "contract not verified" |
| D9 | Eval acceptance criteria incl. per-category minimums | S2.8 gate | Start with the spec targets plus ≥90% per category and 0 trap hallucinations; ratchet upward |
| D10 | Audit retention/archival, backup RPO/RTO, eval-audio consent | S4.6, S5.1 | Needed before the pilot, not before Phase 1 code |
| D11 | Is a sandbox pilot enough, or must the pilot use production Silexx (traders manually submitting real orders)? | Pilot scope, S4.6 | Start in the Silexx sandbox / UAT; move to production after a clean sandbox period |

---

## 3. Scope: Core and V1 remainder

### Core (safe usable release; the pilot gate)

The smallest product a trader can use for real equity orders without breaking any
invariant.

- **Orders:** equity market / limit / stop / stop-limit, one order per utterance.
  An utterance with several orders gets an explicit "one order at a time" refusal
  that names what was heard; nothing is dropped silently. An options order is
  refused as "not supported yet", never part-parsed.
- **Input:** manual text entry, plus voice through approved self-hosted STT (S3.6).
  If D2 isn't resolved, Core ships text-only and voice is the first V1 item.
- **Parsing:** deterministic normalization, side lexicon with a disagreement rule,
  fast path, local LLM with schema-constrained output, prompt-injection checks.
- **Safety:** server-authoritative drafts; versioned per-draft confirmation;
  validation that blocks, or warns and requires acknowledgement; duplicate prompt;
  R-ATOMIC; R-VERIFY; handoff state machine with uncertain/reconcile states;
  handoff kill switch.
- **Silexx:** the **real adapter** (S5.2) against the sandbox. The stub is for
  development and CI only.
- **Trust:** hash-chained audit with `audit:verify`; SSO; per-user scoping
  (trader role only).
- **Ops:** CI with eval gate, per-stage tracing, health checks, staging deploy,
  encrypted backups with one tested restore.
- **UI:** draft card with state badges, inline edit, warnings, handoff status,
  keyboard-only flow, screen-reader announcements.
- **Defaults** are built-in and not user-editable yet. The on-screen sentence is
  the readback.

### V1 remainder (after Core, before calling it V1)

| Feature | Tasks |
|---|---|
| Multi-order utterances, one card per order | S2.5, S3.1 multi-card acceptance |
| Single-leg options | S2.6 (+ D8) |
| Voice corrections to existing drafts | S3.7 |
| Supervisor (read-only) and auditor roles | S4.2 roles part |
| Per-user settings dashboard + 30-day history | S4.3 |
| Audit viewer + CSV/JSON export (Core has DB access + `audit:verify`) | S4.4 |
| Monitoring dashboard beyond basic tracing | S4.5 dashboard part |

**Simplified for V1:**
- Model/rule updates are **manually activated** after a passing eval run
  (automatic activation stays off until D9 is defined; the spec allows this).
- Monitoring = OTel → one dashboard; in-app error banners. No email alerts.
- Voice correction: only "change <field> on <draft>" style, asking which draft
  when it's unclear. No free-form multi-draft voice editing.

**Out (post-V1):** streaming partial transcripts, TTS readback, automatic model
activation and rollback, k6/auto-scaling, investigation console, multi-leg options.
The trader study runs *on* the pilot.

---

## 4. Cross-cutting rules

These apply to every task that touches drafts, audit or Silexx. Acceptance tests
for those tasks must cover them.

### R-ATOMIC: draft state and audit change together or not at all

1. **One transaction per transition.** Every state change (create, edit,
   acknowledge, confirm, cancel, each handoff state change, manual reconciliation)
   runs in one PostgreSQL transaction that (a) locks the draft row
   (`SELECT … FOR UPDATE`), (b) checks the expected `version`/state
   (compare-and-set), (c) updates the draft, (d) appends the audit row(s), and
   (e) commits. Any failure rolls back everything, and the API returns an error
   with the draft unchanged. **If audit can't be written, the action doesn't happen
   (fail closed).**
2. **Serialized chain appends.** Appending to the hash chain takes a lock on a
   single `audit_chain_head` row (or a transaction-scoped advisory lock), so
   concurrent transactions can't fork the chain. `prev_hash` is read under that lock.
3. **No external calls inside a transaction.** LLM, STT and Silexx calls happen
   outside transactions. Parse: call the LLM first, then one transaction creates
   the draft(s) and the interpretation audit rows.
4. **Durable intent before every Silexx call.** Transaction 1 moves `confirmed →
   in_progress`, stores the idempotency key, writes `HANDOFF_ATTEMPT`, and commits.
   Only then is Silexx called. Transaction 2 records the outcome plus its audit row.
   If the process dies between them, the startup sweep moves `in_progress →
   uncertain` (audited) and **never re-sends**.
5. **Concurrency is decided by the database.** Double-click confirm, confirm racing
   an edit, and two tabs starting a handoff all resolve through the version/state
   compare-and-set: exactly one wins, and the others get `409 STALE_VERSION` or
   `409 INVALID_STATE`.
6. **Append-only is enforced by the database**, not by convention: the app's DB role
   has INSERT/SELECT only on the audit table, and a trigger rejects UPDATE/DELETE.
7. **Required tests:** fault injection (audit insert fails → draft unchanged; crash
   after transaction 1 → `uncertain` on restart, no second Silexx call); concurrent
   confirm → exactly one success; concurrent appends → `audit:verify` passes.

### R-VERIFY: what counts as a successful handoff

A handoff is **successful** only when all of these hold:

1. Silexx returned 2xx with a body that passes schema validation and contains a
   ticket ID. A 2xx with a missing or malformed body is **uncertain**, not success.
2. If the API echoes the idempotency key, it matches the one sent.
3. **Read-back** (when D1 confirms lookup): the app fetches the ticket and checks
   that every handed-off field matches the confirmed version (symbol, side, quantity,
   order type, limit/stop prices, TIF, account, and option fields later), **and that
   its status is draft/unsubmitted**.

Outcomes:

| Observation | State | Trader sees |
|---|---|---|
| All checks pass, read-back confirms | `populated_verified` | "Populated in Silexx, fields verified. Not submitted. Review and submit in Silexx." |
| 2xx + ticket ID, but no lookup capability | `populated_unverified` | "Silexx accepted the draft, but the app can't verify it. Check the ticket fields in Silexx before submitting." Never shown as verified |
| Read-back fields differ | `mismatch` | Blocking alert: "Ticket in Silexx does not match your confirmed order. Do not submit it; correct or delete it in Silexx." The app never edits or deletes it |
| Read-back shows submitted / working / routed | `safety_violation` | Critical alert + audit `SAFETY_VIOLATION`; **the handoff kill switch trips automatically** for all users until an admin investigates and resets it |
| Timeout, connection reset after send, 5xx, malformed 2xx | `uncertain` | "Outcome unknown: check Silexx manually." Reconcile via lookup if available |

The **kill switch** (env/admin flag) can only *disable* handoff; nothing can use it
to skip a safeguard. While it's tripped, drafts can still be created and reviewed,
and the UI says why handoff is unavailable.

---

## 5. Tasks

Status: ⬜ not started · 🔄 in progress · ✅ done · ⛔ blocked on a decision.
Tier: **[Core]** or **[V1]**. "After" = hard dependency. Groundwork that already
exists is noted where it helps; it does not change status (see §7).

### Phase 0: Housekeeping (½ day)

**S0.1 ✅ [Core] Single source of truth for guidance.** *Re-scoped 2026-10-28:* the
spec became `DESIGN_DOC.md` (not `CLAUDE.md`); `setup.md`, `DESIGN.md`,
`docs/ROADMAP.md` and `docs/PLAN.md` were deleted instead of patched; PLAN.md's
working rules and baselines moved into this file. ADRs kept.
*Accept:* `DESIGN_DOC.md` + `IMPLEMENTATION_PLAN.md` are the only planning docs at
the root; no doc recommends hosted LLM/STT.

**S0.2 🔄 [Core] CI** (was M1.7). GitHub Actions: lint, `npm run build` (the client
`typecheck` script checks nothing), server Jest, Playwright e2e, plus a Postgres
service container once S1.5 lands.
*Done so far:* `.github/workflows/ci.yml`. The root `build` script now builds
`shared` first: from a clean checkout the old workspace order built `server`
against a `shared/dist` that didn't exist yet, and local runs only passed thanks
to a stale `dist`. Verified on a clean clone: lint, build, 62/62 Jest, 4/4 e2e
pass; a planted client type error fails `build` (exit 2).
*Accept:* workflow green on main; a type error in `client/` fails it.

### Phase 1: Safety core (server-authoritative drafts and handoff)

Can start now against the stub; needs only D3a (Postgres). Order inside the phase:
S1.1 → S1.5 → S1.2 → S1.3/S1.6 → S1.4.

**S1.1 ⬜ [Core] Domain model v2** (`shared/`). After S0.2.
`OrderType` gets `STOP_LIMIT`. `OrderDraft` gets `version`, `contentHash`,
`timeInForce?`, `account?`, `option?: { expiry, strike, right, openClose? }`,
`warnings[]`, `acknowledgedWarnings[]`. Separate `DraftState`
(`draft | awaiting_confirmation | confirmed | cancelled`) and `HandoffState`
(`none | in_progress | populated_verified | populated_unverified | failed_known |
uncertain | mismatch | safety_violation | reconciliation_required`).
Remove `SubmittedOrder`. Parse API returns `{ drafts[], clarifications[], refusals[] }`.
*Accept:* build passes; types make "confirmed without version" and "handoff state
on an unconfirmed draft" unrepresentable where practical.

**S1.5 ⬜ [Core] Hash-chained audit log + transaction layer** (was M5.2/M5.3).
After S1.1, D3a, D6. *Moved ahead of S1.2 because R-ATOMIC needs it.*
Postgres with migrations. A unit-of-work helper (`withTransaction(fn)`) that draft
and audit repositories share. Audit table per R-ATOMIC 2 and 6: each row stores
`prev_hash` and `hash = H(prev_hash || canonical(row))`. `npm run audit:verify`.
Event types: draft created/edited (original + diff), validation warning/error,
clarification asked/answered, acknowledgement, confirm, cancel, handoff
attempt/outcome/read-back/reconcile, kill switch trip/reset, `SAFETY_VIOLATION`,
auth, settings change, component versions, export, LLM/lexicon disagreement.
*Groundwork:* `auditService` interface and the before/after-Silexx tests can be kept.
*Accept:* editing, deleting or reordering any row fails `verify`; UPDATE/DELETE
are rejected by the DB; concurrent appends leave a valid chain (R-ATOMIC 7).

**S1.2 ⬜ [Core] Draft store + lifecycle service.** After S1.5.
Postgres-backed; every transition follows R-ATOMIC. Drafts are created only by
the parse pipeline and scoped to `userId`. `PATCH /api/drafts/:id` takes
`{version, changes}`, bumps `version`, clears confirmation, and re-validates.
`POST /api/drafts/:id/confirm` takes `{version}` and fails if stale, if blocking
errors exist, or if warnings aren't acknowledged. The old `POST /api/draft` is removed.
*Accept:* tests show that (a) a client can't confirm or hand off a draft the server
didn't create; (b) any edit after confirm requires re-confirm; (c) user A gets 404
on user B's draft; (d) a failed audit insert leaves the draft unchanged;
(e) concurrent confirm + edit → exactly one wins.

**S1.3 ⬜ [Core] Validation service.** After S1.1.
Required fields per order type and asset class. Blocking errors vs. warnings.
Configurable sanity checks (max qty, max notional, price distance from a reference)
that are **inactive unless configured** (D7). Stale or missing reference data is
disclosed as a warning, never treated as a pass. Never auto-modifies a draft.
In Core, `assetClass: OPTION` is a blocking "not supported yet" error.
*Accept:* unit tests per rule; stop-limit without both prices is blocked; an
unconfigured check produces no warning and no false "checked" label.

**S1.6 ⬜ [Core] Duplicate detection.** After S1.2.
Same user, same economic fields, within a configurable window (open or recently
confirmed) → `possible_duplicate` warning that needs explicit acknowledgement.
*Accept:* repeating an order surfaces the prompt; nothing is dropped silently.

**S1.4 ⬜ [Core] Handoff state machine + Silexx adapter interface.** After S1.2.
```
SilexxAdapter {
  capabilities: { idempotency: boolean; lookup: boolean; readBack: boolean }
  populate(draft, idempotencyKey): Promise<PopulateResult>
  lookup?(idempotencyKey | ticketId): Promise<TicketSnapshot | 'absent'>
}
```
Idempotency key = `draftId:version:contentHash`. Hard timeout. Intent-then-call
per R-ATOMIC 4. Outcomes are classified per R-VERIFY: definite rejection before
acceptance → `failed_known`; everything ambiguous → `uncertain`. Retry only when
`idempotency` is supported, otherwise only after a lookup confirms `absent`.
Startup sweep: `in_progress` → `uncertain`. Kill switch checked before transaction 1.
Extend the stub with switchable modes: ok, ok-without-lookup, reject,
timeout-after-accept, 5xx, 2xx-malformed, 2xx-missing-ticket-ID,
read-back-mismatch, read-back-submitted.
*Groundwork:* `silexxClient.ts` audit-before/after pattern and `silexx-stub.mjs`.
*Accept:* one test per stub mode asserting the R-VERIFY state; no path reports
`uncertain`, `populated_unverified` or `mismatch` as verified success;
`read-back-submitted` trips the kill switch; no automatic retry without
idempotency or a confirmed `absent`; a known failure on an unchanged draft keeps
its confirmation, an uncertain outcome doesn't; crash after transaction 1 → no
second call.

### Phase 2: Parsing pipeline (needs the eval first)

**S2.1 ⬜ [Core] Eval covers the real pipeline + missing categories.** After S1.1.
The runner calls the same `parseUtterance()` entry point the route uses. The source
hash covers all pipeline files. Add harness unit tests (was M1.6). Write
**before** the features: `prompt_injection`, `stop_limit`, `tif_account`,
`llm_lexicon_conflict`, `multi_order`, `options` (≥10 heldout each). In Core, the
expected result for `multi_order`/`options` is the refusal; the V1 tasks switch it
to the full expectation.
*Groundwork:* M1.1–M1.5 (harness, CIs, compare, stratified split) are done.
*Accept:* new baseline recorded with the new categories; `DESIGN_DOC.md`'s dataset
claim is now true; benchmark hardware documented in `server/eval/README.md`.

**S2.2 ⬜ [Core] Deterministic normalization.** After S2.1.
Spoken numbers and price idioms ("one ninety five fifty", "and a quarter"),
spelled tickers ("A A P L"), filler removal, corrections ("no wait", "make that")
that change only the corrected field.
*Accept:* unit tests per idiom; `correction` ≥ 90%, `filler` ≥ 95% on dev; no
significant regression elsewhere (`compare.mts`).

**S2.3 ⬜ [Core] Side lexicon + disagreement rule.** After S2.2.
Code decides the side from a verb lexicon. If the LLM's side disagrees, return a
clarification and audit the conflict (never pick one).
*Accept:* `side_lexicon` ≥ 95% dev; trap hallucinations stay 0.

**S2.4 ⬜ [Core] Unified pipeline + fast path + schema-constrained LLM.** After S2.3.
normalize → deterministic parse → (fully resolved? skip LLM) → LLM with
`response_format: json_schema` → resolve symbols → validate → drafts. Delete
`ENABLE_NLP`. LLM unreachable → clear "parsing service unavailable" error; drafts
are kept; no fallback to another provider. Spoken text is order data only: the LLM
output is checked field by field against the normalized transcript (e.g. a quantity
must appear in the utterance). Several orders in one utterance → the Core refusal.
*Accept:* fast-path hit rate and per-path p50/p95 reported; 0 malformed-output
failures on a full dev run; `prompt_injection` 100%; `multi_order` and `options`
refused 100%.

**S2.7 ⬜ [Core] Latency + model choice → ADR 003** (was M2.8/M2.9). After S2.4.
Shrink the prompt; compare 2–3 local models and quantizations on accuracy and p95.
*Accept:* ADR committed; LLM-path p95 < 1.5 s on the documented hardware, or the
shortfall recorded with a go/no-go decision for the pilot.

**S2.8 ⬜ [Core] Eval gate in CI + activation record.** After S0.2, S2.4, D9.
`--min-accuracy`, per-category minimums, `--max-hallucinations`; thresholds in
`eval/ci-thresholds.json` (ratchet). Activating a model, prompt or rule set
records versions plus the eval result in the audit log; the previous version is
kept for manual rollback.
*Accept:* a PR with a deliberately broken prompt fails CI.

**S2.5 ⬜ [V1] Multi-order.** After S2.4. Segment the utterance into orders; each
order becomes an independent draft or clarification; one failure doesn't block
the others. *Accept:* `multi_order` ≥ 90% dev with full expectations.

**S2.6 ⬜ [V1] Single-leg options.** After S2.4, D8. Parse underlying / expiry /
strike / C/P / open-close / contracts; build the OCC symbol; resolve expiry dates
deterministically; refuse or clarify when more than one contract is plausible;
extend R-VERIFY read-back to option fields.
*Accept:* `options` ≥ 90% dev; unit tests for OCC symbols and expiry resolution.

### Phase 3: Trader UI

**S3.1 ⬜ [Core] Draft cards.** After S1.2, S2.4.
Card per draft with its own state badge (Clarification required / Draft ready /
Awaiting confirmation / Confirmed / Handoff in progress / Populated, verified /
Populated, unverified: check Silexx / Mismatch: do not submit / Outcome uncertain:
check Silexx / Handoff disabled). Confirm and cancel act per card.
*Groundwork:* `ReviewPanel` (warning banner, symbol banner, order sentence).
*Accept (Core):* each badge renders from its state. *Accept (V1, after S2.5):*
Playwright confirms one of two drafts and the other stays untouched.

**S3.2 ⬜ [Core] Editable fields + warnings.** After S3.1, S1.3, S1.6.
Inline edit (calls PATCH with `version`; confirmation visibly resets). Required,
warning and blocking states are visually distinct. Warning acknowledgement
checkboxes gate Confirm. Duplicate prompt. A `409 STALE_VERSION` reloads the card
and explains why.
*Accept:* e2e: edit after confirm → card returns to Awaiting confirmation.

**S3.3 ⬜ [Core] Manual text entry.** After S2.4. Text box → same `/api/parse`; same cards.
*Accept:* e2e drafts an order with no microphone.

**S3.4 ⬜ [Core] Handoff status UX.** After S1.4, S3.1. Copy per the R-VERIFY table.
`uncertain` / `populated_unverified` → "Mark as checked in Silexx: present and
correct / absent / wrong" (audited; "absent" allows a new handoff only through
S1.4's rules). No blind retry button. Every screen says "not submitted / not executed".
*Accept:* e2e against each stub mode shows the correct state and copy.

**S3.5 ⬜ [Core] Accessibility pass.** After S3.2.
Put Confirm back in the tab order (still never auto-focused, Enter in text fields
never confirms); `aria-live` announcements for new cards, warnings and handoff
outcomes; axe check in e2e.
*Accept:* a keyboard-only Playwright test completes parse → edit → acknowledge →
confirm; axe reports no serious issues.

**S3.6 ⬜ [Core, conditional on D2] Self-hosted STT.** After D2. whisper.cpp service;
client MediaRecorder → `POST /api/transcribe`; audio is processed in memory and
never written to disk; Web Speech removed or dev-flag only. STT down → error +
text entry stays usable. If D2 slips, Core ships text-only and this becomes the
first V1 item.
*Accept:* e2e with a fixture clip; a test asserts no audio file is persisted.

**S3.7 ⬜ [V1] Voice corrections to existing drafts.** After S3.1, S2.4.
"Make that 200" applies to the only open draft or asks which; never edits several.
*Accept:* e2e for one draft and for the ambiguous two-draft case.

### Phase 4: Identity, settings, operations

**S4.1 ⬜ [Core] SSO.** After D4. OIDC login, server session cookie, fail closed.
When a session expires, drafts are kept and confirm/handoff are disabled until re-login.
*Groundwork:* JWT middleware gives per-request `userId`; replaced, not extended.
*Accept:* no session → 401 everywhere except health; expiry mid-review blocks
confirm, and drafts survive re-login.

**S4.2 ⬜ [Core: scoping · V1: roles] Roles + scoping.** After S4.1.
Core: every draft, history and audit query is scoped to the session user.
V1: supervisor (read-only on assigned traders) and auditor (export) roles.
*Accept (Core):* cross-user access → 404. *Accept (V1):* supervisor can read but
can't create, edit or confirm.

**S4.5 ⬜ [Core: tracing · V1: dashboard] Observability.** After S2.4, S1.4.
Core: OTel spans per stage (transcribe, normalize, deterministic, LLM, resolve,
validate, handoff, read-back); health for LLM/STT/Silexx/DB; counters for handoff
outcomes by R-VERIFY state and kill switch trips. V1: one dashboard with fast-path
rate and refusals by reason. Telemetry carries no transcripts or order details.
*Accept:* a slow request can be traced to its stage; a log/attribute scan finds no
transcript text.

**S4.6 ⬜ [Core] Deployment, backups, recovery.** After D3b, D10. Container images,
staging + pilot environment with a private URL, secrets from a secret store,
documented rollback. Encrypted automated backups plus one tested restore; after a
restore, the startup sweep moves in-progress handoffs to `uncertain` and nothing is
re-sent; `audit:verify` passes on the restored DB.
*Accept:* fresh staging deploy from CI; restore drill documented with times.

**S4.3 ⬜ [V1] Settings + history.** After S1.2, S4.1. Per-user defaults seeded from
built-ins (seeding never overwrites saved values). Drafts snapshot the settings
used at creation. Changes are audited in the same transaction (R-ATOMIC). 30-day
recent-history view (separate from audit).
*Accept:* tests for seeding, snapshotting, and that safety rules can't be disabled.

**S4.4 ⬜ [V1] Audit viewer + export.** After S1.5, S4.2. Basic list + filter; CSV/JSON
export with permission check; the export itself is audited; secrets excluded.
*Accept:* unauthorized export → 403; authorized export creates an audit row.

### Phase 5: Silexx integration and release readiness

**S5.2 ⬜ ⛔ D1 [Core, pilot-blocking] Real Silexx adapter.** After S1.4, D1, D5.
Implement `SilexxAdapter` against the sandbox. Set capability flags from tested
behaviour, not documentation. Implement read-back if the API allows it.
*Accept:* the S3.4 e2e suite passes against the sandbox; for a confirmed ticket,
read-back (or a manual check, if there's no lookup) shows it **populated with
matching fields and not submitted**; a forced timeout produces `uncertain` and
reconciles correctly.

**S5.1 ⬜ [Core if S3.6 ships] Audio eval** (was M4.1/M4.3/M4.5). After S3.6, D10
consent policy. ≥100 clips, ≥3 speakers, noise subset; WER and audio-to-draft vs.
transcript-to-draft. *Accept:* WER < 8%, gap ≤ 5 pts, speak-to-draft p95 < 3 s,
or the shortfall recorded with a go/no-go decision for voice in the pilot.

**S5.3 ⬜ [Core] Threat model + safety review** (was M5.1). STRIDE incl. speech
prompt injection, replayed confirms, session theft, audit tampering, Silexx
response spoofing; map each threat to the test that covers it. Walk through
INV-1…12, R-ATOMIC and R-VERIFY and link each to evidence.
*Accept:* `docs/threat-model.md` + `docs/invariants-evidence.md` committed.

**S5.4 ⬜ [Core → pilot; repeated for V1] Staging sign-off → pilot / production.**
Heldout eval at release versions, security checks, Silexx behaviour against the
sandbox, kill-switch drill, rollback rehearsal; approval recorded.

---

## 6. Order, critical path and the pilot

```
S0.1 → S0.2 → S1.1 ─┬─ S1.5 → S1.2 ─┬─ S1.4 ──────────────┐
                    │               ├─ S1.6               │
                    ├─ S1.3 ────────┘                     ├─ S3.1 → S3.2 → S3.5
                    └─ S2.1 → S2.2 → S2.3 → S2.4 ─────────┤        S3.3, S3.4
                                         └─ S2.7, S2.8    │
D1 ─────────────────────────────────────────── S5.2 ──────┤  (pilot-blocking)
D4 → S4.1 → S4.2(scoping) ; D3b → S4.6 ; D2 → S3.6 → S5.1 ┴→ S5.3 → S5.4 = PILOT
V1 after pilot: S2.5 → S3.1(multi) ; S2.6 ; S3.7 ; S4.2(roles) → S4.4 ; S4.3 ; S4.5(dashboard)
```

**The pilot depends on the real Silexx adapter.** The pilot gate is **all Core tasks,
including S5.2**. The stub can't show that a ticket actually lands as an unsubmitted
draft with the right fields, which is the product's core claim and the basis of
R-VERIFY. Consequences:

- **D1 is the critical path.** Send the question to Cboe now. Phases 0–4 proceed
  against the stub in parallel, but no trader uses the system until S5.2 passes.
- **If D1 is slow:** an internal **dry run** on the stub (staff only, no Silexx,
  clearly labelled) can test the UI and parsing. It is not the pilot and doesn't
  count as Silexx validation.
- **If D1 = no lookup/read-back:** the pilot can still run, but every success is
  `populated_unverified` and traders are told to verify in Silexx. Record that as
  an accepted risk in S5.3.
- **If D1 = no draft-without-submit API:** stop and re-scope (see D1) before Phase 3.
- **Pilot environment** follows D11: sandbox first. The trader study (spec
  §"Trader validation study") runs during the pilot.

**Two tracks in parallel:** the safety core (S1.x) and parsing (S2.x) touch
different code and share only S1.1.

---

## 7. Status verification (2026-10-28, HEAD `dba25da`)

Checked against the repository. Every task except S0.1 stays ⬜ because none of
their acceptance criteria are met:

| Check | Result | Tasks affected |
|---|---|---|
| Planning docs | `DESIGN_DOC.md` + `IMPLEMENTATION_PLAN.md` at root; obsolete docs deleted | S0.1 ✅ |
| `.github/workflows/` | Absent (added 2026-10-30, not yet run on GitHub) | S0.2 🔄 |
| `npm test` (server) | 62/62 pass: regex parser, NLP (mocked), symbols, audit, Silexx client | Groundwork only |
| `npx playwright test` | 4/4 pass with mocked API (happy, parse error, gate, cancel) | Groundwork only |
| `STOP_LIMIT`, `version` in `shared/types/order.ts` | Absent; `SubmittedOrder` still present | S1.1 ⬜ |
| Server-side draft store, confirm endpoint | Absent; `POST /api/draft` accepts the client's draft | S1.2 ⬜ |
| Audit chain / Postgres / transactions | NDJSON `appendFile`, no hash, no transactions | S1.5 ⬜ |
| Silexx timeout, idempotency, read-back | None (`silexxClient.ts` has no abort; any 2xx = success) | S1.4 ⬜, S5.2 ⬜ |
| Eval categories `prompt_injection` / `multi_order` / `options` | Not in `server/eval/types.ts`; the eval calls `interpretWithNLP` directly | S2.1 ⬜ |
| `ENABLE_NLP` | Still selects between two parse paths (`routes/parse.ts:75`) | S2.4 ⬜ |
| Confirm button `tabIndex={-1}` | Still present (`ReviewPanel.tsx:276`) | S3.5 ⬜ |
| Manual text entry, `/api/transcribe`, SSO, OTel, deploy config | Absent | S3.3, S3.6, S4.1, S4.5, S4.6 ⬜ |

Done before this plan and not repeated here: M1.1–M1.5 (commits `42adc55`,
`963567e`, `6c71dd7`, `95cef12`, `dba25da`; see §9). The old step tables are in
`git show dba25da:docs/PLAN.md`.

---

## 8. Technical risks

| Risk | Impact | Mitigation |
|---|---|---|
| No Silexx draft-without-submit API (D1) | Core value gone | Resolve first; the adapter interface keeps the rest of the work valid either way |
| No Silexx lookup/read-back | Success can't be verified; uncertain outcomes can't be reconciled | `populated_unverified` state with explicit trader check; accepted-risk entry in S5.3 |
| Integration submits instead of drafting (misread API) | INV-1 breach | R-VERIFY status check, automatic kill switch, sandbox-only until S5.4 |
| Partial writes / crash mid-handoff | Audit and reality diverge; duplicate tickets | R-ATOMIC: one transaction per transition, durable intent, startup sweep to `uncertain` |
| LLM p95 3.96 s vs 1.5 s target | Voice slower than typing | Fast path (S2.4) takes the LLM off most traffic; S2.7 model/prompt work; document hardware |
| Shared self-hosted LLM/STT under concurrent traders | Latency spikes, cross-user mixups | Per-request IDs end to end; queue depth metric (S4.5); measure in pilot before scaling |
| Options without a chain source | Can't verify a contract exists | D8: accept only fully specified contracts, warn "unverified" (V1) |
| Eval overfitting (dev tuned heavily) | Heldout numbers drop | Heldout only at phase exits; add pilot utterances as new cases |
| Hash-chain lock contention | Slower writes under load | Single-row lock is cheap at pilot scale; measure in S4.5 before optimizing |

---

## 9. Eval baselines and progress log

| Version | Commit | Split | n | Case acc. | Hallucination | False reject | Ambiguity recall | p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| v1 | `42adc55` | dev | 210 | 76.2% | 0.0% | 26.9% | 61.5% | 2.18 s / 2.67 s |
| v1 | `42adc55` | heldout | 66 | 80.3% | 0.0% | 21.7% | 0/1 | 2.37 s / 2.81 s |
| v2 | `d7ceaaf`+ | dev | 289 | 94.5% [91.2–96.6] | 0/97 [0–3.8] | 8.4% [5.1–13.6] | 14/14 | 2.59 s / 3.96 s |
| v2 | `d7ceaaf`+ | heldout | 174 | 94.3% [89.8–96.9] | 0/57 [0–6.3] | 5.2% [2.2–11.5] | 10/10 | 2.65 s / 3.86 s |

v2 runs used nlp source hash `df3682169930` (unchanged since v1); `+` = run on the
then-uncommitted M1.2–M1.4 eval changes. The jump from v1 is the dataset, not the
parser. Weakest dev categories: `side_lexicon` (76%), `correction` (82%),
`filler` (85%).

**Sprint branch `sprint-30min` (2026-10-30, experimental, may be scrapped).** A
time-boxed attempt at the Phase 1 safety core plus the Core UI changes. It does
**not** change any task status: the store is an in-memory, file-snapshotted
stand-in for Postgres (D3a), so R-ATOMIC 6 (DB-enforced append-only) and the
real-DB parts of S1.2/S1.5 aren't met. If kept, S1.x is redone on Postgres behind
the same `Store` interface. Covered on the branch: S1.1 types, S1.3 validation,
S1.6 duplicates, S1.2 lifecycle (version CAS on every transition), S1.5 hash chain +
`audit:verify`, S1.4 adapter + R-VERIFY + kill switch + startup sweep + all 9 stub
modes, S3.1–S3.5 UI (cards, inline edit, warnings, handoff copy, keyboard Confirm),
S3.3 text entry, Core multi-order/options refusals. Not touched: `services/nlp`
(eval hash unchanged), S2.x parsing, SSO, OTel, deploy.

| Date | Task | Evidence |
|---|---|---|
| 2026-10-06 | M1.1 | `42adc55`: 276 cases; v1 baseline dev 76.2%, heldout 80.3% |
| 2026-10-26 | M1.2 | Runner prints a 95% Wilson interval on every rate (v2 result files store `ci95`) |
| 2026-10-26 | M1.3 | `compare.mts` v1 dev → v2 dev: 45 paired cases, 0 fixed / 0 broke, p = 1.00 |
| 2026-10-26 | M1.4 | 463 cases (289 dev / 174 heldout); smallest heldout category n = 10; regeneration byte-identical |
| 2026-10-26 | M1.5 | v2 dev 94.5%, heldout 94.3%; v1 results moved to `results/archive/` |
| 2026-10-28 | S0.1 | Spec renamed to `DESIGN_DOC.md`; `setup.md`, `DESIGN.md`, `docs/ROADMAP.md`, `docs/PLAN.md` deleted |
